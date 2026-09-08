import type { ServerResponse } from "node:http";
import { DASHBOARD_SCHEMA_VERSION, ID_LIMIT } from "./contracts.js";
import { writeDashboardJson } from "./http.js";
import type { DashboardLookup, DashboardReadModel } from "./read-model.js";
import { parseControlPage, type ControlPageInput } from "./control-request-read.js";
import { JarvisError } from "../db.js";

const TASK_LIMIT_MIN = 1;
const TASK_LIMIT_MAX = 500;

const READ_ERROR = {
  VALIDATION_ERROR: { status: 400, code: "VALIDATION_ERROR", message: "Validation error" },
  TASK_NOT_FOUND: { status: 404, code: "TASK_NOT_FOUND", message: "Task not found" },
  AGENT_NOT_FOUND: { status: 404, code: "AGENT_NOT_FOUND", message: "Agent not found" },
  CONTROL_PAGE_STALE: { status: 409, code: "CONTROL_PAGE_STALE", message: "Approval list changed. Return to the first page." },
} as const;

type ReadRoute =
  | { readonly kind: "tasks"; readonly limit: number }
  | { readonly kind: "task"; readonly taskId: string }
  | { readonly kind: "agents" }
  | { readonly kind: "agent"; readonly agentId: string }
  | { readonly kind: "control_requests"; readonly page?: ControlPageInput }
  | { readonly kind: "invalid" }
  | { readonly kind: "unhandled" };

export type DashboardReadRouteInput = {
  readonly model: DashboardReadModel;
  readonly url: string | undefined;
  readonly path: string;
  readonly response: ServerResponse;
  readonly requestId: string;
  readonly now?: Date;
};

export function tryHandleDashboardRead(input: DashboardReadRouteInput): boolean {
  const route = matchReadRoute(input.path, input.url);
  switch (route.kind) {
    case "unhandled":
      return false;
    case "invalid":
      writeReadError(input, READ_ERROR.VALIDATION_ERROR);
      return true;
    case "tasks":
      writeDashboardJson(input.response, { status: 200, body: input.model.listTasks(route.limit), requestId: input.requestId });
      return true;
    case "task":
      writeLookup(input, input.model.taskDetail(route.taskId), READ_ERROR.TASK_NOT_FOUND);
      return true;
    case "agents":
      writeDashboardJson(input.response, { status: 200, body: input.model.listAgents(input.now), requestId: input.requestId });
      return true;
    case "agent":
      writeLookup(input, input.model.agentDetail(route.agentId, input.now), READ_ERROR.AGENT_NOT_FOUND);
      return true;
    case "control_requests":
      try {
        writeDashboardJson(input.response, { status: 200,
          body: input.model.listControlRequests(input.now, route.page), requestId: input.requestId });
      } catch (error) {
        if (!(error instanceof JarvisError) || error.code !== "CONTROL_PAGE_STALE") throw error;
        writeReadError(input, READ_ERROR.CONTROL_PAGE_STALE);
      }
      return true;
    default:
      return assertNever(route);
  }
}

function matchReadRoute(path: string, url: string | undefined): ReadRoute {
  if (path === "/api/v1/tasks") {
    const limit = parseTaskLimit(url);
    return limit === undefined ? { kind: "invalid" } : { kind: "tasks", limit };
  }
  if (path === "/api/v1/agents") return { kind: "agents" };
  if (path === "/api/v1/control/requests") {
    const page = parseControlPage(url);
    return page === "invalid" ? { kind: "invalid" }
      : page === "legacy" ? { kind: "control_requests" } : { kind: "control_requests", page };
  }
  const taskId = singleSegment(path, "/api/v1/tasks/");
  if (taskId !== undefined) {
    const parsed = parseResourceId(taskId);
    return parsed === undefined ? { kind: "invalid" } : { kind: "task", taskId: parsed };
  }
  const agentId = singleSegment(path, "/api/v1/agents/");
  if (agentId !== undefined) {
    const parsed = parseResourceId(agentId);
    return parsed === undefined ? { kind: "invalid" } : { kind: "agent", agentId: parsed };
  }
  return { kind: "unhandled" };
}

function singleSegment(path: string, prefix: string): string | undefined {
  if (!path.startsWith(prefix)) return undefined;
  const rest = path.slice(prefix.length);
  if (rest.length === 0 || rest.includes("/")) return undefined;
  return rest;
}

function parseTaskLimit(url: string | undefined): number | undefined {
  try {
    const raw = new URL(url ?? "/", "http://127.0.0.1").searchParams.get("limit");
    if (raw === null || !/^[1-9]\d{0,2}$/.test(raw)) return undefined;
    const limit = Number(raw);
    if (limit < TASK_LIMIT_MIN || limit > TASK_LIMIT_MAX) return undefined;
    return limit;
  } catch (error) {
    if (error instanceof TypeError) return undefined;
    throw error;
  }
}

function parseResourceId(value: string): string | undefined {
  if (value.length === 0 || Buffer.byteLength(value, "utf8") > ID_LIMIT) return undefined;
  return value;
}

function writeLookup<T>(
  input: DashboardReadRouteInput,
  result: DashboardLookup<T>,
  missing: (typeof READ_ERROR)["TASK_NOT_FOUND"] | (typeof READ_ERROR)["AGENT_NOT_FOUND"],
): void {
  switch (result.kind) {
    case "found":
      writeDashboardJson(input.response, { status: 200, body: result.value, requestId: input.requestId });
      return;
    case "not_found":
      writeReadError(input, missing);
      return;
    default:
      assertNever(result);
  }
}

function writeReadError(
  input: DashboardReadRouteInput,
  error: (typeof READ_ERROR)[keyof typeof READ_ERROR],
): void {
  writeDashboardJson(input.response, {
    status: error.status,
    requestId: input.requestId,
    body: {
      schema_version: DASHBOARD_SCHEMA_VERSION,
      error: { code: error.code, message: error.message, request_id: input.requestId },
    },
  });
}

function assertNever(value: never): never {
  throw new Error(`unexpected dashboard read route: ${JSON.stringify(value)}`);
}
