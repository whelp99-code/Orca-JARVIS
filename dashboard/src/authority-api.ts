import type { StoredControlCommand } from "../../src/control-plane.js";
import type { DashboardTaskExecution } from "../../src/dashboard/task-execution-read.js";
import type { PrepareTaskExecutionRequest, PreparedDashboardTaskExecution, StageDashboardTaskExecutionRequest, DashboardTaskReadiness } from "../../src/dashboard/task-execution-service.js";
import type { TaskExecutionPlanV2 } from "../../src/task-execution-plan.js";
import { parsePreparedExecution, parseTaskExecution } from "./task-execution-guard.js";
import type {
  CancelRequest,
  ReceiptDecisionRequest,
  RetryRequest,
} from "../../src/dashboard/contracts.js";
import type {
  DashboardDecision,
  DashboardExecution,
} from "../../src/dashboard/authority-service.js";
import {
  DashboardApiError,
  type ApiErrorKind,
  type SessionResponse,
} from "./api.js";

export type AuthorityIdKind = "request_id" | "nonce";
export type AuthorityIdFactory = (kind: AuthorityIdKind) => string;
export type AuthorityMutationClient = Readonly<{
  decideRequest: (requestId: string, request: ReceiptDecisionRequest) => Promise<DashboardDecision>;
  executeRequest: (requestId: string) => Promise<DashboardExecution>;
  cancelTask: (taskId: string, request: CancelRequest) => Promise<StoredControlCommand>;
  retryRequest: (sourceRequestId: string, request: RetryRequest) => Promise<StoredControlCommand>;
  taskExecution?: TaskExecutionClient;
}>;
export type TaskExecutionClient = Readonly<{
  read: (taskId: string, signal?: AbortSignal) => Promise<DashboardTaskExecution>;
  prepare: (taskId: string, request: PrepareTaskExecutionRequest) => Promise<PreparedDashboardTaskExecution>;
  stage: (taskId: string, request: StageDashboardTaskExecutionRequest) => Promise<StoredControlCommand>;
  check: (taskId: string, plan: TaskExecutionPlanV2) => Promise<DashboardTaskReadiness>;
}>;

const ACTION_LEVELS = [0, 1, 2, 3, 4, 5] as const;
const COMMAND_STATES = [
  "pending", "approved", "rejected", "claimed", "completed", "failed", "uncertain", "cancelled",
] as const;
const EXECUTION_STATES = ["completed", "failed", "uncertain"] as const;
const CSRF_HEADER = "X-JARVIS-CSRF";
const REQUEST_TIMEOUT_MS = 10_000;
const SAFE_MESSAGES = {
  offline: "Dashboard unavailable",
  forbidden: "Request forbidden",
  not_found: "Request not found",
  server: "Dashboard request failed",
} as const satisfies Record<ApiErrorKind, string>;

export const SYSTEM_AUTHORITY_ID_FACTORY: AuthorityIdFactory = (kind) => (
  `${kind}-${globalThis.crypto.randomUUID()}`
);

type SessionLoader = () => Promise<SessionResponse>;
type Parser<T> = (value: unknown) => T | undefined;
type Mutation<T> = Readonly<{ path: string; body: unknown; parse: Parser<T>; timeout?: number }>;

export function createAuthorityMutationClient(
  loadSession: SessionLoader = fetchSession,
): AuthorityMutationClient {
  let tokenRequest: Promise<string> | undefined;
  async function csrfToken(): Promise<string> {
    tokenRequest ??= loadCsrfToken(loadSession);
    try {
      return await tokenRequest;
    } catch (error: unknown) {
      tokenRequest = undefined;
      throw error;
    }
  }
  async function mutate<T>(input: Mutation<T>): Promise<T> {
    return await postJson(input, await csrfToken());
  }
  return {
    decideRequest: async (requestId, body) => await mutate({
      path: `/api/v1/control/requests/${encodeURIComponent(requestId)}/decision`,
      body,
      parse: (value) => {
        const parsed = parseDecision(value);
        return parsed?.request_id === requestId ? parsed : undefined;
      },
    }),
    executeRequest: async (requestId) => await mutate({
      path: `/api/v1/control/requests/${encodeURIComponent(requestId)}/execute`,
      body: { schema_version: 1 },
      timeout: 660_000,
      parse: (value) => {
        const parsed = parseExecution(value);
        return parsed?.execution.request_id === requestId ? parsed : undefined;
      },
    }),
    cancelTask: async (taskId, body) => await mutate({
      path: `/api/v1/tasks/${encodeURIComponent(taskId)}/cancel`,
      body,
      parse: (value) => {
        const parsed = parseCommandEnvelope(value);
        return parsed?.request_id === body.request_id ? parsed : undefined;
      },
    }),
    retryRequest: async (sourceRequestId, body) => await mutate({
      path: `/api/v1/control/requests/${encodeURIComponent(sourceRequestId)}/retry`,
      body,
      parse: (value) => {
        const parsed = parseCommandEnvelope(value);
        return parsed?.request_id === body.request_id ? parsed : undefined;
      },
    }),
    taskExecution: {
      check: async (taskId, plan) => await mutate({ path: `/api/v1/tasks/${encodeURIComponent(taskId)}/execution/check`,
        body: { schema_version: 1, plan }, timeout: 45_000,
        parse: value => {
          if (!isRecord(value) || value.schema_version !== 1 || value.task_id !== taskId || value.run_id !== plan.run_id
            || typeof value.execution_plan_digest !== "string" || !isRecord(value.readiness)
            || value.readiness.provider !== plan.provider || value.readiness.authentication !== "not_probed"
            || !["ready", "unavailable"].includes(String(value.readiness.state))
            || value.execution_available !== (value.readiness.state === "ready")
            || (value.readiness.state === "unavailable" && typeof value.readiness.reason_code !== "string")) return undefined;
          return value as DashboardTaskReadiness;
        } }),
      read: async (taskId, signal) => {
        const response = await request(`/api/v1/tasks/${encodeURIComponent(taskId)}/execution`,
          { headers: { Accept: "application/json", [CSRF_HEADER]: await csrfToken() }, signal });
        const body = await responseBody(response);
        if (!response.ok) throw errorFromResponse(response, body);
        const parsed = parseTaskExecution(body, taskId);
        if (!parsed) throw validationError(requestId(response));
        return parsed;
      },
      prepare: async (taskId, body) => await mutate({ path: `/api/v1/tasks/${encodeURIComponent(taskId)}/execution/prepare`,
        body, timeout: 45_000, parse: value => parsePreparedExecution(value, taskId, body.run_id) }),
      stage: async (taskId, body) => await mutate({ path: `/api/v1/tasks/${encodeURIComponent(taskId)}/execution/stage`, body, timeout: 45_000,
        parse: value => {
          const parsed = parseCommandEnvelope(value);
          return parsed?.request_id === body.request_id && parsed.action === "task.execute" && parsed.target.task_id === taskId
            && parsed.target.run_id === body.plan.run_id ? parsed : undefined;
        } }),
    },
  };
}

async function loadCsrfToken(loadSession: SessionLoader): Promise<string> {
  try {
    const session = await loadSession();
    if (!isSession(session)) throw validationError("");
    return session.csrf_token;
  } catch (error: unknown) {
    if (error instanceof DashboardApiError) {
      throw safeError(
        error.kind,
        safeIdentifier(error.code) ?? error.kind.toUpperCase(),
        safeIdentifier(error.request_id) ?? "",
      );
    }
    if (error instanceof TypeError || error instanceof DOMException) {
      throw safeError("offline", "OFFLINE", "");
    }
    throw error;
  }
}

async function fetchSession(): Promise<SessionResponse> {
  const response = await request("/api/v1/session", { headers: { Accept: "application/json" } });
  const body = await responseBody(response);
  if (!response.ok) throw errorFromResponse(response, body);
  if (!isSession(body)) throw validationError(requestId(response));
  return body;
}

async function postJson<T>(input: Mutation<T>, csrfToken: string): Promise<T> {
  const response = await request(input.path, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      [CSRF_HEADER]: csrfToken,
    },
    body: JSON.stringify(input.body),
  }, input.timeout);
  const body = await responseBody(response);
  if (!response.ok) throw errorFromResponse(response, body);
  const parsed = input.parse(body);
  if (parsed === undefined) throw validationError(requestId(response));
  return parsed;
}

async function request(path: string, init: RequestInit, timeout = REQUEST_TIMEOUT_MS): Promise<Response> {
  try {
    return await fetch(path, {
      ...init,
      credentials: "same-origin",
      signal: init.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout),
    });
  } catch (error: unknown) {
    if (error instanceof TypeError || error instanceof DOMException) {
      throw safeError("offline", "OFFLINE", "");
    }
    throw error;
  }
}

async function responseBody(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch (error: unknown) {
    if (error instanceof SyntaxError) throw validationError(requestId(response));
    throw error;
  }
}

function parseDecision(value: unknown): DashboardDecision | undefined {
  if (!isRecord(value) || value.schema_version !== 1 || typeof value.request_id !== "string") return undefined;
  switch (value.decision) {
    case "approve":
      return value.state === "approved" ? {
        schema_version: 1,
        request_id: value.request_id,
        decision: "approve",
        state: "approved",
      } : undefined;
    case "reject":
      return value.state === "rejected" ? {
        schema_version: 1,
        request_id: value.request_id,
        decision: "reject",
        state: "rejected",
      } : undefined;
    default:
      return undefined;
  }
}

function parseExecution(value: unknown): DashboardExecution | undefined {
  if (!isRecord(value) || value.schema_version !== 1 || !isRecord(value.execution)) return undefined;
  const execution = value.execution;
  if (typeof execution.request_id !== "string" || typeof execution.action !== "string"
    || !isMemberOf(execution.state, EXECUTION_STATES)) return undefined;
  if ("failure_code" in execution && typeof execution.failure_code !== "string") return undefined;
  return {
    schema_version: 1,
    execution: {
      request_id: execution.request_id,
      action: execution.action,
      state: execution.state,
      ...(typeof execution.failure_code === "string" ? { failure_code: execution.failure_code } : {}),
    },
  };
}

function parseCommandEnvelope(value: unknown): StoredControlCommand | undefined {
  if (!isRecord(value) || value.schema_version !== 1 || !isStoredCommand(value.request)) return undefined;
  return value.request;
}

function isStoredCommand(value: unknown): value is StoredControlCommand {
  return isRecord(value) && value.schema_version === 1
    && typeof value.request_id === "string" && typeof value.action === "string"
    && isMemberOf(value.action_level, ACTION_LEVELS) && isRecord(value.target) && isRecord(value.args)
    && typeof value.reversible === "boolean" && typeof value.requested_by === "string"
    && typeof value.requested_at === "string" && typeof value.expires_at === "string"
    && typeof value.nonce === "string" && typeof value.command_digest === "string"
    && isMemberOf(value.state, COMMAND_STATES);
}

function isSession(value: unknown): value is SessionResponse {
  return isRecord(value) && value.schema_version === 1 && typeof value.csrf_token === "string"
    && /^[A-Za-z0-9_-]{32,128}$/u.test(value.csrf_token);
}

function errorFromResponse(response: Response, body: unknown): DashboardApiError {
  const kind = kindFromStatus(response.status);
  if (isRecord(body) && body.schema_version === 1 && isRecord(body.error)) {
    const code = safeIdentifier(body.error.code) ?? kind.toUpperCase();
    const responseId = safeIdentifier(body.error.request_id) ?? requestId(response);
    return safeError(kind, code, responseId);
  }
  return safeError(kind, kind.toUpperCase(), requestId(response));
}

function validationError(responseRequestId: string): DashboardApiError {
  return safeError("server", "VALIDATION_ERROR", responseRequestId);
}

function safeError(kind: ApiErrorKind, code: string, responseRequestId: string): DashboardApiError {
  return new DashboardApiError({ kind, code, message: SAFE_MESSAGES[kind], request_id: responseRequestId });
}

function kindFromStatus(status: number): ApiErrorKind {
  if (status === 401 || status === 403) return "forbidden";
  if (status === 404) return "not_found";
  return "server";
}

function requestId(response: Response): string {
  return safeIdentifier(response.headers.get("X-Request-Id")) ?? "";
}

function safeIdentifier(value: unknown): string | undefined {
  return typeof value === "string" && /^[A-Za-z0-9_.:-]{1,128}$/u.test(value) ? value : undefined;
}

function isMemberOf<T extends string | number>(value: unknown, allowed: readonly T[]): value is T {
  return allowed.some((item) => item === value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
