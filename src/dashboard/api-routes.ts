import type { WorkboardActions } from "../workboard/actions.js";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { CapabilityProbe } from "../capabilities.js";
import type { AuthorityDb } from "../db.js";
import type { MemoryLifecycleService } from "../memory-lifecycle-service-types.js";
import type { DashboardExecutorFactory } from "./authority-service.js";
import type { RemoteApprovalService } from "../remote-approval.js";
import { tryHandleRemoteLifecycleRoutes } from "./remote-lifecycle-routes.js";
import { tryHandleRemoteAuthRoutes } from "./remote-auth-routes.js";
import { buildSecondBrainReadiness, type SecondBrainReadinessProbe } from "../second-brain-readiness.js";
import { cachedRuntimeSecondBrainReadinessProbe } from "../second-brain-readiness-cache.js";
import { DASHBOARD_SCHEMA_VERSION, ID_LIMIT } from "./contracts.js";
import type { ReconcileHub } from "./events.js";
import {
  DASHBOARD_ERROR_CODES,
  writeDashboardError,
  writeDashboardJson,
} from "./http.js";
import { tryHandleExternalDelegate } from "./external-delegate-routes.js";
import { tryHandleFinanceRead } from "./finance-read-routes.js";
import { tryHandleMailCandidates } from "./mail-candidates-routes.js";
import { tryHandleMailSummary } from "./mail-summary-routes.js";
import { tryHandleOwnerInbox } from "./owner-inbox-routes.js";
import { tryHandleDashboardPost } from "./post-routes.js";
import { tryHandleMemoryRead } from "./memory-read-routes.js";
import type { MemoryRuntime } from "./memory-runtime.js";
import { tryHandlePersonalRead } from "./personal-routes.js";
import type { TeamProposalPlanner } from "./proposal-service.js";
import type { DashboardReadModel } from "./read-model.js";
import { tryHandleDashboardRead } from "./read-routes.js";
import { tryHandleTaskExecution } from "./task-execution-routes.js";
import { tryHandleDashboardSession, type DashboardSessionStore } from "./session.js";
import { tryHandleDashboardSse } from "./sse-route.js";
import { tryHandleWorkboardRead } from "./workboard-routes.js";
import type { DashboardTerminalReader, TerminalLogResult } from "./terminal-reader.js";

const LOG_LIMIT_MIN = 1;
const LOG_LIMIT_MAX = 500;

const API_ERROR = {
  VALIDATION_ERROR: { status: 400, code: "VALIDATION_ERROR", message: "Validation error" },
  AGENT_NOT_FOUND: { status: 404, code: "AGENT_NOT_FOUND", message: "Agent not found" },
  ORCA_UNAVAILABLE: { status: 502, code: "ORCA_UNAVAILABLE", message: "Orca unavailable" },
} as const;

export type DashboardApiInput = {
  readonly db: AuthorityDb;
  readonly model: DashboardReadModel;
  readonly terminals: DashboardTerminalReader;
  readonly url: string | undefined;
  readonly path: string;
  readonly request: IncomingMessage;
  readonly response: ServerResponse;
  readonly requestId: string;
  readonly hub: ReconcileHub;
  readonly session: DashboardSessionStore;
  readonly origin: string;
  readonly clock: () => Date;
  readonly capabilityProbe?: CapabilityProbe;
  readonly secondBrainProbe?: SecondBrainReadinessProbe;
  readonly planner?: TeamProposalPlanner;
  readonly memoryLifecycle?: Pick<MemoryLifecycleService, "execute">;
  readonly executorFactory?: DashboardExecutorFactory;
  readonly memoryRuntime: MemoryRuntime;
  readonly remoteApproval?: RemoteApprovalService;
  readonly ownerInbox?: import("../owner-inbox.js").OwnerInbox;
  readonly assertionCheck?: import("../owner-inbox.js").AssertionCheck;
  readonly enrollmentCheck?: import("../owner-inbox-enrollment.js").EnrollmentCheck;
  readonly now?: Date;
  readonly workboardActions?: WorkboardActions;
  readonly priceFinance?: import("../integration/price-finance-production.js").PriceFinanceRuntime;
  readonly mailCandidates?: import("../integration/mail-candidates-production.js").MailCandidatesRuntime;
  readonly mailSource?: import("../personal-connector-mail-source.js").MailPersonalConnectorSource;
};

type LogsRoute =
  | { readonly kind: "logs"; readonly agentId: string; readonly limit: number }
  | { readonly kind: "invalid" }
  | { readonly kind: "unhandled" };

export async function tryHandleDashboardApi(input: DashboardApiInput): Promise<boolean> {
  if (input.remoteApproval) {
    const remote = {
      service: input.remoteApproval, path: input.path, request: input.request,
      response: input.response, requestId: input.requestId, session: input.session,
      origin: input.origin, clock: input.clock,
    };
    if (await tryHandleRemoteLifecycleRoutes(remote)) return true;
    if (await tryHandleRemoteAuthRoutes(remote)) return true;
  }
  if (await tryHandleExternalDelegate(input)) return true;
  if (await tryHandleOwnerInbox(input)) return true;
  if (await tryHandleFinanceRead(input)) return true;
  if (await tryHandleMailCandidates(input)) return true;
  if (await tryHandleMailSummary(input)) return true;
  if (input.request.method === "POST") return tryHandleDashboardPost(input);
  if (await tryHandleTaskExecution(input)) return true;
  if (tryHandleDashboardSession(input)) return true;
  if (tryHandleDashboardSse(input)) return true;
  if (input.path === "/api/v1/health") {
    await writeHealth(input.db, input.response, input.requestId, input.clock(), input.secondBrainProbe ?? cachedRuntimeSecondBrainReadinessProbe());
    return true;
  }
  if (input.path === "/api/v1/overview") {
    writeDashboardJson(input.response, {
      status: 200,
      body: await input.model.overview(input.clock()),
      requestId: input.requestId,
    });
    return true;
  }
  if (tryHandleWorkboardRead({ db: input.db.db, path: input.path, response: input.response,
    requestId: input.requestId, now: input.clock(), actions: input.workboardActions })) return true;
  if (await tryHandleDashboardLogs(input)) return true;
  if (await tryHandleMemoryRead({ path: input.path, url: input.url, request: input.request,
    response: input.response, requestId: input.requestId, session: input.session,
    runtime: input.memoryRuntime })) return true;
  if (await tryHandlePersonalRead({
    model: input.model.personal,
    url: input.url,
    path: input.path,
    response: input.response,
    requestId: input.requestId,
    now: input.clock(),
  })) return true;
  return tryHandleDashboardRead({
    model: input.model,
    url: input.url,
    path: input.path,
    response: input.response,
    requestId: input.requestId,
    now: input.clock(),
  });
}

async function tryHandleDashboardLogs(input: DashboardApiInput): Promise<boolean> {
  const route = matchLogsRoute(input.path, input.url);
  switch (route.kind) {
    case "unhandled":
      return false;
    case "invalid":
      writeApiError(input, API_ERROR.VALIDATION_ERROR);
      return true;
    case "logs":
      writeLogResult(input, await input.terminals.read(route.agentId, route.limit));
      return true;
    default:
      return assertNever(route);
  }
}

function writeLogResult(input: DashboardApiInput, result: TerminalLogResult): void {
  switch (result.kind) {
    case "ok":
      writeDashboardJson(input.response, {
        status: 200,
        body: result.value,
        requestId: input.requestId,
      });
      return;
    case "not_found":
      writeApiError(input, API_ERROR.AGENT_NOT_FOUND);
      return;
    case "orca_unavailable":
      writeApiError(input, API_ERROR.ORCA_UNAVAILABLE);
      return;
    default:
      assertNever(result);
  }
}

function matchLogsRoute(path: string, url: string | undefined): LogsRoute {
  const prefix = "/api/v1/agents/";
  const suffix = "/logs";
  if (!path.startsWith(prefix) || !path.endsWith(suffix)) return { kind: "unhandled" };
  const agentId = path.slice(prefix.length, -suffix.length);
  if (agentId.length === 0 || agentId.includes("/")) return { kind: "unhandled" };
  const parsed = parseResourceId(agentId);
  const limit = parseLogLimit(url);
  if (parsed === undefined || limit === undefined) return { kind: "invalid" };
  return { kind: "logs", agentId: parsed, limit };
}

function parseLogLimit(url: string | undefined): number | undefined {
  try {
    const raw = new URL(url ?? "/", "http://127.0.0.1").searchParams.get("limit");
    if (raw === null || !/^[1-9]\d{0,2}$/.test(raw)) return undefined;
    const limit = Number(raw);
    if (limit < LOG_LIMIT_MIN || limit > LOG_LIMIT_MAX) return undefined;
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

function writeApiError(
  input: DashboardApiInput,
  error: (typeof API_ERROR)[keyof typeof API_ERROR],
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

async function writeHealth(
  db: AuthorityDb,
  response: ServerResponse,
  requestId: string,
  now: Date,
  secondBrainProbe: SecondBrainReadinessProbe,
): Promise<void> {
  try {
    await db.assertMigrationsReady();
  } catch (error) {
    if (error instanceof Error) {
      writeDashboardError(response, {
        status: 503,
        code: DASHBOARD_ERROR_CODES.AUTHORITY_NOT_READY,
        requestId,
      });
      return;
    }
    throw error;
  }
  writeDashboardJson(response, {
    status: 200,
    body: {
      schema_version: DASHBOARD_SCHEMA_VERSION,
      status: "ok",
      authority: "ready",
      generated_at: Number.isFinite(now.getTime()) ? now.toISOString() : null,
      second_brain: await buildSecondBrainReadiness(secondBrainProbe, now),
    },
    requestId,
  });
}

function assertNever(value: never): never {
  throw new Error(`unexpected dashboard api route: ${JSON.stringify(value)}`);
}
