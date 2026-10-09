import { capabilitySchema } from "../../src/workboard/action-contracts.js";
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
import type {
  WorkboardCard,
  WorkboardEvidenceItem,
  WorkboardGroup,
  WorkboardResponse,
} from "../../src/dashboard/workboard-routes.js";
import { isPortfolioOverview } from "./portfolio-guard.js";
import { isRuntimeIdentity, isDaemonRuntimeIdentity } from "./runtime-guard.js";
import type { DashboardSurface } from "./surface.js";
import { priceFinanceConfigSchema, priceFinanceReceiptSchema,
  priceCompanyBindingReceiptSchema, type PriceCompanyBindingReceipt,
  type PriceFinanceConfig, type PriceFinanceReceipt, type PriceFinanceRequest } from "../../src/integration/price-finance-contract.js";

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
  readonly overview: (signal?: AbortSignal) => Promise<OverviewResponse>;
  readonly tasks: (signal?: AbortSignal) => Promise<TaskListResponse>;
  readonly agents: (signal?: AbortSignal) => Promise<AgentListResponse>;
  readonly controlRequests: (signal?: AbortSignal, cursor?: string) => Promise<ControlRequestListResponse>;
  readonly task: (taskId: string) => Promise<TaskDetailResponse>;
  readonly agentLogs: (agentId: string) => Promise<TerminalLogResponse>;
  readonly workboard: (signal?: AbortSignal) => Promise<WorkboardResponse>;
  readonly priceFinanceConfig?: (signal?: AbortSignal) => Promise<PriceFinanceConfig>;
  readonly priceFinanceRead?: (request: PriceFinanceRequest, signal?: AbortSignal) => Promise<PriceFinanceReceipt>;
  readonly priceCompanyBinding?: (signal?: AbortSignal) => Promise<PriceCompanyBindingReceipt>;
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

const TASK_KINDS = ["work", "command", "workflow", "agent", "recommendation"] as const;
const EVENT_SOURCES = ["work", "control", "workflow", "gjc", "verification", "progress"] as const;
const EVENT_KINDS = ["status", "command", "approval", "workflow", "agent", "verification", "evidence", "system"] as const;
const ACTION_LEVELS = [0, 1, 2, 3, 4, 5] as const;
const WORK_DISPOSITIONS = ["running", "waiting", "blocked", "failed", "paused", "claimed_done", "verified", "unknown"] as const;
const WORK_ATTEMPTS = ["running", "waiting", "stopped", "unknown"] as const;
const WORK_DELIVERIES = ["none", "cancel_requested", "delivering", "delivered", "uncertain"] as const;
const WORK_WAIT_KINDS = ["user_decision", "dependency", "long_running", "verification"] as const;
const PURPOSE_STATUSES = ["confirmed", "proposed", "unknown"] as const;
const LIST_LIMIT = 500;

export function createDashboardClient(surface: DashboardSurface = "local"): DashboardClient {
  const session = surface === "phone" ? phoneSession() : () => readJson("/api/v1/session", isSession);
  async function financeJson(path: string, signal?: AbortSignal) {
    const own = await session();
    return requestJson(path, signal, own.csrf_token);
  }
  return {
    session,
    overview: (signal) => readJson("/api/v1/overview", isOverview, signal),
    tasks: (signal) => readJson(`/api/v1/tasks?limit=${String(LIST_LIMIT)}`, isTaskList, signal),
    agents: (signal) => readJson("/api/v1/agents", isAgentList, signal),
    controlRequests: (signal, cursor) => readJson(`/api/v1/control/requests?limit=50${cursor === undefined
      ? "" : `&cursor=${encodeURIComponent(cursor)}`}`, isApprovalList, signal),
    task: (taskId) => readJson(`/api/v1/tasks/${encodeURIComponent(taskId)}`, isTaskDetail),
    agentLogs: (agentId) => readJson(
      `/api/v1/agents/${encodeURIComponent(agentId)}/logs?limit=${String(LIST_LIMIT)}`,
      isTerminalLog,
    ),
    workboard: (signal) => readJson("/api/v1/workboard", isWorkboard, signal),
    priceFinanceConfig: async signal => priceFinanceConfigSchema.parse(await financeJson("/api/v1/finance-read/config", signal)),
    priceCompanyBinding: async signal => priceCompanyBindingReceiptSchema.parse(await financeJson(
      "/api/v1/finance-read/company-binding", signal)),
    priceFinanceRead: async (request, signal) => priceFinanceReceiptSchema.parse(await financeJson(
      `/api/v1/finance-read?${new URLSearchParams(request).toString()}`, signal)),
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

/**
 * The gateway mints a new session and cookie on every call to its session route, so
 * concurrent reads must share one bootstrap or their cookies and CSRF tokens cross.
 */
function phoneSession(): () => Promise<SessionResponse> {
  let pending: Promise<SessionResponse> | undefined;
  return () => {
    pending ??= readJson("/api/v1/phone/session", isSession).catch((error: unknown) => { pending = undefined; throw error; });
    return pending;
  };
}

async function readJson<T>(path: string, parse: (value: unknown) => value is T, signal?: AbortSignal): Promise<T> {
  const body = await requestJson(path, signal);
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

async function requestJson(path: string, signal?: AbortSignal, csrf?: string): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(path, {
      headers: { Accept: "application/json", ...(csrf === undefined ? {} : { "x-jarvis-csrf": csrf }) },
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000),
    });
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
    && isPortfolioOverview(value.portfolio)
    && (value.runtime === undefined || isRuntimeIdentity(value.runtime))
    && (value.daemon_identity === undefined || isDaemonRuntimeIdentity(value.daemon_identity));
}

function isTaskList(value: unknown): value is TaskListResponse {
  return isItemList(value, isTask);
}

function isAgentList(value: unknown): value is AgentListResponse {
  return isItemList(value, isAgent);
}

function isApprovalList(value: unknown): value is ControlRequestListResponse {
  if (!isItemList(value, isApproval)) return false;
  const page: unknown = Reflect.get(value, "page");
  if (page === undefined) return true;
  return isRecord(page) && Number.isSafeInteger(page.limit) && Number(page.limit) >= 1 && Number(page.limit) <= 100
    && Number.isSafeInteger(page.total) && Number(page.total) >= value.items.length
    && page.returned === value.items.length && value.items.length <= Number(page.limit)
    && typeof page.has_more === "boolean" && (page.has_more
      ? typeof page.next_cursor === "string" && page.next_cursor.length > 0 && page.next_cursor.length <= 2048
      : page.next_cursor === null);
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
    && (value.task_id === undefined || typeof value.task_id === "string")
    && isActionLevel(value.action_level) && typeof value.requested_at === "string"
    && typeof value.requested_by === "string" && typeof value.summary === "string"
    && typeof value.state === "string"
    && (value.retry_status === undefined || isMember(value.retry_status, ["allowed", "replan_required", "not_allowed"]));
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

function isWorkboard(value: unknown): value is WorkboardResponse {
  return isRecord(value) && value.schema_version === 1 && typeof value.generated_at === "string"
    && typeof value.collected === "boolean"
    && isArrayOf(value.attention, isWorkboardCard) && isArrayOf(value.groups, isWorkboardGroup);
}

function isWorkboardGroup(value: unknown): value is WorkboardGroup {
  return isRecord(value) && isNullable(value.project_id, "string") && isNullable(value.purpose, "string")
    && isMember(value.status, PURPOSE_STATUSES) && isArrayOf(value.works, isWorkboardCard);
}

function isWorkboardCard(value: unknown): value is WorkboardCard {
  return isRecord(value) && typeof value.work_id === "string" && typeof value.summary === "string"
    && (value.action_capability === undefined || capabilitySchema.safeParse(value.action_capability).success)
    && isRecord(value.source) && typeof value.source.host === "string"
    && typeof value.source.app === "string" && typeof value.source.scope === "string"
    && isMember(value.disposition, WORK_DISPOSITIONS) && isMember(value.attempt_execution, WORK_ATTEMPTS)
    && isMember(value.action_delivery, WORK_DELIVERIES)
    && (value.freshness === "fresh" || value.freshness === "unconfirmed")
    && (value.rank === null || value.rank === 0 || value.rank === 1 || value.rank === 2 || value.rank === 3)
    && isStringArray(value.reasons)
    && (value.wait_kind === null || isMember(value.wait_kind, WORK_WAIT_KINDS))
    && isNullable(value.wait_reason, "string") && isNullable(value.wait_started_at, "string")
    && isNullable(value.deadline_at, "string") && isNullable(value.impact, "number")
    && typeof value.actions_enabled === "boolean" && isNullable(value.warning, "string")
    && typeof value.source_at === "string" && isNullable(value.observed_at, "string")
    && isRecord(value.purpose) && isNullable(value.purpose.project_id, "string")
    && isNullable(value.purpose.text, "string") && isMember(value.purpose.status, PURPOSE_STATUSES)
    && isNullable(value.purpose.why, "string") && typeof value.purpose.needs_reconfirmation === "boolean"
    && isArrayOf(value.evidence, isWorkboardEvidence);
}

function isWorkboardEvidence(value: unknown): value is WorkboardEvidenceItem {
  return isRecord(value) && typeof value.label === "string" && typeof value.value === "string";
}

function isNullable(value: unknown, type: "string" | "number"): boolean {
  return value === null || typeof value === type;
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
