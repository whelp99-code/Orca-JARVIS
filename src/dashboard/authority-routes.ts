import type { IncomingMessage, ServerResponse } from "node:http";
import { JarvisError, type AuthorityDb } from "../db.js";
import type { MemoryLifecycleService } from "../memory-lifecycle-service-types.js";
import {
  decideDashboardRequest,
  executeDashboardRequest,
  stageDashboardCancel,
  stageDashboardRetry,
} from "./authority-service.js";
import { DASHBOARD_SCHEMA_VERSION, ID_LIMIT } from "./contracts.js";
import type { ReconcileHub } from "./events.js";
import { writeDashboardJson } from "./http.js";
import { redactDashboardValue } from "./redaction.js";

const ERROR_STATUS = {
  AUTHORITY_RECEIPT_REQUIRED: 403,
  CONTROL_APPROVAL_INVALID: 403,
  CONTROL_APPROVAL_REQUIRED: 403,
  CONTROL_APPROVAL_NOT_APPLICABLE: 409,
  CONTROL_STATE_CONFLICT: 409,
  CONTROL_COMMAND_REPLAY_CONFLICT: 409,
  RETRY_NOT_ALLOWED: 409,
  TASK_NOT_FOUND: 404,
  VALIDATION_ERROR: 400,
  RECEIPT_DECISION_INVALID: 400,
  CONTROL_COMMAND_INVALID: 400,
  TASK_INPUT_INVALID: 400,
} as const;

const ERROR_MESSAGE = {
  AUTHORITY_RECEIPT_REQUIRED: "Authority receipt required",
  CONTROL_APPROVAL_INVALID: "Control approval invalid",
  CONTROL_APPROVAL_REQUIRED: "Control approval required",
  CONTROL_APPROVAL_NOT_APPLICABLE: "Control approval not applicable",
  CONTROL_STATE_CONFLICT: "Control state conflict",
  CONTROL_COMMAND_REPLAY_CONFLICT: "Control command replay conflict",
  RETRY_NOT_ALLOWED: "Retry not allowed",
  TASK_NOT_FOUND: "Task not found",
  VALIDATION_ERROR: "Validation error",
  RECEIPT_DECISION_INVALID: "Receipt decision invalid",
  CONTROL_COMMAND_INVALID: "Invalid control command",
  TASK_INPUT_INVALID: "Invalid task input",
} as const satisfies Record<keyof typeof ERROR_STATUS, string>;

type AuthorityErrorCode = keyof typeof ERROR_STATUS;

type AuthorityRoute =
  | { readonly kind: "decision"; readonly requestId: string }
  | { readonly kind: "execute"; readonly requestId: string }
  | { readonly kind: "retry"; readonly sourceRequestId: string }
  | { readonly kind: "cancel"; readonly taskId: string }
  | { readonly kind: "invalid" }
  | { readonly kind: "unhandled" };

export type AuthorityRouteInput = {
  readonly db: AuthorityDb;
  readonly path: string;
  readonly request: IncomingMessage;
  readonly response: ServerResponse;
  readonly requestId: string;
  readonly body: unknown;
  readonly hub: ReconcileHub;
  readonly clock: () => Date;
  readonly memoryLifecycle?: Pick<MemoryLifecycleService, "execute">;
};

export async function tryHandleAuthorityPost(input: AuthorityRouteInput): Promise<boolean> {
  if (input.request.method !== "POST") return false;
  const route = matchAuthorityRoute(input.path);
  switch (route.kind) {
    case "unhandled":
      return false;
    case "invalid":
      writeMappedError(input, "VALIDATION_ERROR");
      return true;
    case "decision":
      return writeDecision(input, route.requestId);
    case "execute":
      return writeExecute(input, route.requestId);
    case "cancel":
      return writeCancel(input, route.taskId);
    case "retry":
      return writeRetry(input, route.sourceRequestId);
    default:
      return assertNever(route);
  }
}

function writeDecision(input: AuthorityRouteInput, requestId: string): boolean {
  try {
    const body = decideDashboardRequest({
      db: input.db,
      requestId,
      body: input.body,
      now: input.clock(),
    });
    input.hub.publish(["overview", "approvals"]);
    writeDashboardJson(input.response, { status: 200, requestId: input.requestId, body });
    return true;
  } catch (error) {
    if (error instanceof JarvisError) return writeCaught(input, error);
    throw error;
  }
}

async function writeExecute(input: AuthorityRouteInput, requestId: string): Promise<boolean> {
  try {
    const body = await executeDashboardRequest({
      db: input.db,
      requestId,
      body: input.body,
      now: input.clock(),
      memoryLifecycle: input.memoryLifecycle,
    });
    input.hub.publish(["overview", "tasks", "approvals"]);
    writeDashboardJson(input.response, { status: 200, requestId: input.requestId, body });
    return true;
  } catch (error) {
    if (error instanceof JarvisError) return writeCaught(input, error);
    throw error;
  }
}

function writeCancel(input: AuthorityRouteInput, taskId: string): boolean {
  try {
    const staged = stageDashboardCancel({
      db: input.db,
      taskId,
      body: input.body,
      now: input.clock(),
    });
    input.hub.publish(["overview", "tasks", `task:${taskId}`, "approvals"]);
    writeDashboardJson(input.response, {
      status: 202,
      requestId: input.requestId,
      body: redactDashboardValue({ schema_version: DASHBOARD_SCHEMA_VERSION, request: staged }),
    });
    return true;
  } catch (error) {
    if (error instanceof JarvisError) return writeCaught(input, error);
    throw error;
  }
}

function writeRetry(input: AuthorityRouteInput, sourceRequestId: string): boolean {
  try {
    const staged = stageDashboardRetry({
      db: input.db,
      sourceRequestId,
      body: input.body,
      now: input.clock(),
    });
    input.hub.publish(["overview", "approvals"]);
    writeDashboardJson(input.response, {
      status: 202,
      requestId: input.requestId,
      body: redactDashboardValue({ schema_version: DASHBOARD_SCHEMA_VERSION, request: staged }),
    });
    return true;
  } catch (error) {
    if (error instanceof JarvisError) return writeCaught(input, error);
    throw error;
  }
}

function writeCaught(input: AuthorityRouteInput, error: unknown): boolean {
  const mapped = mappedAuthorityError(error);
  if (mapped === undefined) throw error;
  writeMappedError(input, mapped);
  return true;
}

function writeMappedError(input: AuthorityRouteInput, code: AuthorityErrorCode): void {
  writeDashboardJson(input.response, {
    status: ERROR_STATUS[code],
    requestId: input.requestId,
    body: {
      schema_version: DASHBOARD_SCHEMA_VERSION,
      error: { code, message: ERROR_MESSAGE[code], request_id: input.requestId },
    },
  });
}

function mappedAuthorityError(error: unknown): AuthorityErrorCode | undefined {
  if (!(error instanceof JarvisError)) return undefined;
  switch (error.code) {
    case "AUTHORITY_RECEIPT_REQUIRED":
    case "CONTROL_APPROVAL_INVALID":
    case "CONTROL_APPROVAL_REQUIRED":
    case "CONTROL_APPROVAL_NOT_APPLICABLE":
    case "CONTROL_STATE_CONFLICT":
    case "CONTROL_COMMAND_REPLAY_CONFLICT":
    case "RETRY_NOT_ALLOWED":
    case "TASK_NOT_FOUND":
    case "VALIDATION_ERROR":
    case "RECEIPT_DECISION_INVALID":
    case "CONTROL_COMMAND_INVALID":
    case "TASK_INPUT_INVALID":
      return error.code;
    default:
      return undefined;
  }
}

function matchAuthorityRoute(path: string): AuthorityRoute {
  const decisionId = suffixedSegment(path, "/api/v1/control/requests/", "/decision");
  if (decisionId !== undefined) return idRoute(decisionId, (requestId) => ({ kind: "decision", requestId }));
  const executeId = suffixedSegment(path, "/api/v1/control/requests/", "/execute");
  if (executeId !== undefined) return idRoute(executeId, (requestId) => ({ kind: "execute", requestId }));
  const retryId = suffixedSegment(path, "/api/v1/control/requests/", "/retry");
  if (retryId !== undefined) return idRoute(retryId, (sourceRequestId) => ({ kind: "retry", sourceRequestId }));
  const cancelId = suffixedSegment(path, "/api/v1/tasks/", "/cancel");
  if (cancelId !== undefined) return idRoute(cancelId, (taskId) => ({ kind: "cancel", taskId }));
  return { kind: "unhandled" };
}

function idRoute(value: string, route: (id: string) => Exclude<AuthorityRoute, { readonly kind: "invalid" | "unhandled" }>): AuthorityRoute {
  const parsed = parseResourceId(value);
  return parsed === undefined ? { kind: "invalid" } : route(parsed);
}

function suffixedSegment(path: string, prefix: string, suffix: string): string | undefined {
  if (!path.startsWith(prefix) || !path.endsWith(suffix)) return undefined;
  const mid = path.slice(prefix.length, -suffix.length);
  if (mid.length === 0 || mid.includes("/")) return undefined;
  return mid;
}

function parseResourceId(value: string): string | undefined {
  if (value.length === 0 || Buffer.byteLength(value, "utf8") > ID_LIMIT) return undefined;
  return value;
}

function assertNever(value: never): never {
  throw new Error(`unexpected authority route: ${JSON.stringify(value)}`);
}
