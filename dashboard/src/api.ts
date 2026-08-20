import type { ActionLevel } from "../../src/control-plane.js";
import type {
  AgentListResponse,
  ControlRequestListResponse,
  OverviewAgent,
  OverviewApproval,
  OverviewCard,
  OverviewResponse,
  OverviewRisk,
  OverviewTask,
  TaskDetailEvent,
  TaskDetailResponse,
  TaskListResponse,
} from "../../src/dashboard/read-model.js";
import type { TerminalLogResponse } from "../../src/dashboard/terminal-reader.js";
import { isPortfolioOverview } from "./portfolio-guard.js";

export type ApiErrorKind = "offline" | "forbidden" | "not_found" | "server";
export type ApiError = {
  readonly kind: ApiErrorKind;
  readonly code: string;
  readonly message: string;
  readonly request_id: string;
};
export type SessionResponse = { readonly schema_version: 1; readonly csrf_token: string };
export type DashboardClient = {
  readonly session: () => Promise<SessionResponse>;
  readonly overview: () => Promise<OverviewResponse>;
  readonly tasks: () => Promise<TaskListResponse>;
  readonly agents: () => Promise<AgentListResponse>;
  readonly controlRequests: () => Promise<ControlRequestListResponse>;
  readonly task: (taskId: string) => Promise<TaskDetailResponse>;
  readonly agentLogs: (agentId: string) => Promise<TerminalLogResponse>;
};

export class DashboardApiError extends Error {
  readonly name = "DashboardApiError";
  readonly kind: ApiErrorKind;
  readonly code: string;
  readonly request_id: string;
  constructor(init: ApiError) {
    super(init.message);
    this.kind = init.kind;
    this.code = init.code;
    this.request_id = init.request_id;
  }
}

const TASK_KINDS = ["work", "command", "workflow", "agent"] as const;
const EVENT_SOURCES = ["work", "control", "workflow", "gjc", "verification", "progress"] as const;
const EVENT_KINDS = ["status", "command", "approval", "workflow", "agent", "verification", "evidence", "system"] as const;
const ACTION_LEVELS = [0, 1, 2, 3, 4, 5] as const;
const LIST_LIMIT = 500;

export function createDashboardClient(): DashboardClient {
  return {
    session: () => readJson("/api/v1/session", isSession),
    overview: () => readJson("/api/v1/overview", isOverview),
    tasks: () => readJson(`/api/v1/tasks?limit=${String(LIST_LIMIT)}`, isTaskList),
    agents: () => readJson("/api/v1/agents", isAgentList),
    controlRequests: () => readJson("/api/v1/control/requests", isApprovalList),
    task: (taskId) => readJson(`/api/v1/tasks/${encodeURIComponent(taskId)}`, isTaskDetail),
    agentLogs: (agentId) => readJson(
      `/api/v1/agents/${encodeURIComponent(agentId)}/logs?limit=${String(LIST_LIMIT)}`,
      isTerminalLog,
    ),
  };
}

export function classifyDashboardError(error: unknown): ApiError {
  if (error instanceof DashboardApiError) {
    return { kind: error.kind, code: error.code, message: error.message, request_id: error.request_id };
  }
  if (error instanceof TypeError || error instanceof DOMException) {
    return { kind: "offline", code: "OFFLINE", message: "Offline", request_id: "" };
  }
  if (error instanceof Error) {
    const kind = kindFromMessage(error.message);
    return { kind, code: kind.toUpperCase(), message: error.message, request_id: "" };
  }
  return { kind: "server", code: "INTERNAL_ERROR", message: "Internal error", request_id: "" };
}

async function readJson<T>(path: string, parse: (value: unknown) => value is T): Promise<T> {
  const body = await requestJson(path);
  if (!parse(body)) {
    throw new DashboardApiError({
      kind: "server",
      code: "VALIDATION_ERROR",
      message: "Validation error",
      request_id: "",
    });
  }
  return body;
}

async function requestJson(path: string): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(path, { headers: { Accept: "application/json" } });
  } catch (error: unknown) {
    throw new DashboardApiError(classifyDashboardError(error));
  }
  const requestId = response.headers.get("X-Request-Id") ?? "";
  let body: unknown;
  try {
    body = await response.json();
  } catch (error: unknown) {
    if (error instanceof SyntaxError) {
      throw new DashboardApiError({
        kind: kindFromStatus(response.status),
        code: "JSON_INVALID",
        message: "Invalid JSON",
        request_id: requestId,
      });
    }
    throw error;
  }
  if (!response.ok) throw errorFromBody(response.status, requestId, body);
  return body;
}

function errorFromBody(status: number, requestId: string, body: unknown): DashboardApiError {
  const kind = kindFromStatus(status);
  if (isRecord(body) && body.schema_version === 1 && isRecord(body.error)
    && typeof body.error.code === "string"
    && typeof body.error.message === "string"
    && typeof body.error.request_id === "string") {
    return new DashboardApiError({
      kind,
      code: body.error.code,
      message: body.error.message,
      request_id: body.error.request_id,
    });
  }
  return new DashboardApiError({ kind, code: kind.toUpperCase(), message: kind, request_id: requestId });
}

function kindFromStatus(status: number): ApiErrorKind {
  if (status === 401 || status === 403) return "forbidden";
  if (status === 404) return "not_found";
  return "server";
}

function kindFromMessage(message: string): ApiErrorKind {
  if (message === "offline" || message === "Failed to fetch") return "offline";
  if (message === "forbidden") return "forbidden";
  if (message === "not_found") return "not_found";
  return "server";
}

function isSession(value: unknown): value is SessionResponse {
  return isRecord(value) && value.schema_version === 1 && typeof value.csrf_token === "string";
}

function isOverview(value: unknown): value is OverviewResponse {
  return isRecord(value) && value.schema_version === 1 && typeof value.generated_at === "string"
    && isArrayOf(value.cards, isCard)
    && isArrayOf(value.recent_tasks, isTask)
    && isArrayOf(value.pending_approvals, isApproval)
    && isArrayOf(value.risks, isRisk)
    && isArrayOf(value.agents, isAgent)
    && isPortfolioOverview(value.portfolio);
}

function isTaskList(value: unknown): value is TaskListResponse {
  return isItemList(value, isTask);
}

function isAgentList(value: unknown): value is AgentListResponse {
  return isItemList(value, isAgent);
}

function isApprovalList(value: unknown): value is ControlRequestListResponse {
  return isItemList(value, isApproval);
}

function isItemList<T>(value: unknown, item: (entry: unknown) => entry is T): value is { readonly schema_version: 1; readonly items: readonly T[] } {
  return isRecord(value) && value.schema_version === 1 && isArrayOf(value.items, item);
}

function isTaskDetail(value: unknown): value is TaskDetailResponse {
  return isRecord(value) && value.schema_version === 1 && isRecord(value.context)
    && isTask(value.context.task) && isArrayOf(value.context.events, isEvent);
}

function isTerminalLog(value: unknown): value is TerminalLogResponse {
  return isRecord(value) && value.schema_version === 1
    && typeof value.agent_id === "string" && typeof value.status === "string"
    && isStringArray(value.lines) && typeof value.truncated === "boolean"
    && (value.next_cursor === null || typeof value.next_cursor === "string");
}

function isCard(value: unknown): value is OverviewCard {
  return isRecord(value) && typeof value.id === "string" && typeof value.label === "string"
    && typeof value.value === "number" && typeof value.detail === "string";
}

function isTask(value: unknown): value is OverviewTask {
  return isRecord(value) && typeof value.task_id === "string" && typeof value.title === "string"
    && isMember(value.kind, TASK_KINDS) && typeof value.state === "string"
    && typeof value.updated_at === "string" && typeof value.pending_approval === "boolean"
    && isStringArray(value.source_ids);
}

function isApproval(value: unknown): value is OverviewApproval {
  return isRecord(value) && typeof value.request_id === "string" && typeof value.action === "string"
    && isActionLevel(value.action_level) && typeof value.requested_at === "string"
    && typeof value.requested_by === "string" && typeof value.summary === "string"
    && typeof value.state === "string";
}

function isRisk(value: unknown): value is OverviewRisk {
  return isRecord(value) && typeof value.id === "string"
    && typeof value.severity === "string" && typeof value.message === "string";
}

function isAgent(value: unknown): value is OverviewAgent {
  return isRecord(value) && typeof value.agent_id === "string" && typeof value.provider === "string"
    && typeof value.terminal_id === "string" && typeof value.incarnation_id === "string"
    && typeof value.canonical_path === "string" && typeof value.status === "string";
}

function isEvent(value: unknown): value is TaskDetailEvent {
  return isRecord(value) && typeof value.event_id === "string" && typeof value.task_id === "string"
    && isMember(value.source, EVENT_SOURCES) && isMember(value.kind, EVENT_KINDS)
    && typeof value.actor === "string" && typeof value.title === "string"
    && (value.status === null || typeof value.status === "string") && "payload" in value
    && isStringArray(value.evidence_refs) && typeof value.created_at === "string"
    && typeof value.sequence === "number";
}

function isActionLevel(value: unknown): value is ActionLevel {
  return ACTION_LEVELS.some((level) => level === value);
}

function isMember<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return typeof value === "string" && allowed.some((item) => item === value);
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isArrayOf<T>(value: unknown, item: (entry: unknown) => entry is T): value is readonly T[] {
  return Array.isArray(value) && value.every(item);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
