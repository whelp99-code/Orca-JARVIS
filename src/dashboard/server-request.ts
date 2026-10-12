import type { WorkboardActions } from "../workboard/actions.js";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { CapabilityProbe } from "../capabilities.js";
import type { SecondBrainReadinessProbe } from "../second-brain-readiness.js";
import { JarvisError, type AuthorityDb } from "../db.js";
import type { MemoryLifecycleService } from "../memory-lifecycle-service-types.js";
import { writeOwnerInboxPreflight } from "../owner-inbox-preflight.js";
import type { DashboardExecutorFactory } from "./authority-service.js";
import type { RemoteApprovalService } from "../remote-approval.js";
import { tryHandleDashboardApi } from "./api-routes.js";
import { isOwnerInboxPath } from "./owner-inbox-routes.js";
import type { ReconcileHub } from "./events.js";
import {
  createRequestId,
  DASHBOARD_ERROR_CODES,
  isLoopbackHostHeader,
  writeDashboardError,
  writeDashboardHtml,
} from "./http.js";
import type { MemoryRuntime } from "./memory-runtime.js";
import type { TeamProposalPlanner } from "./proposal-service.js";
import type { DashboardReadModel } from "./read-model.js";
import type { DashboardSessionStore } from "./session.js";
import {
  hasFileNameExtension,
  isAssetRequest,
  readStaticIndex,
  requestPath,
  safeAssetRelative,
  writeStaticAsset,
} from "./static-assets.js";
import type { DashboardTerminalReader } from "./terminal-reader.js";

type RequestContext = {
  readonly db: AuthorityDb;
  readonly model: DashboardReadModel;
  readonly terminals: DashboardTerminalReader;
  readonly staticRoot: string;
  readonly request: IncomingMessage;
  readonly response: ServerResponse;
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
  readonly workboardActions?: WorkboardActions;
  readonly priceFinance?: import("../integration/price-finance-production.js").PriceFinanceRuntime;
  readonly mailCandidates?: import("../integration/mail-candidates-production.js").MailCandidatesRuntime;
  readonly mailSource?: import("../personal-connector-mail-source.js").MailPersonalConnectorSource;
};

export async function handleRequest(input: RequestContext): Promise<void> {
  const requestId = createRequestId(input.request);
  try {
    if (!isLoopbackHostHeader(input.request.headers.host)) {
      writeDashboardError(input.response, {
        status: 403,
        code: DASHBOARD_ERROR_CODES.LOCAL_SESSION_REQUIRED,
        requestId,
      });
      return;
    }
    const path = requestPath(input.request.url);
    const method = input.request.method;
    if (path !== undefined && method === "OPTIONS" && isOwnerInboxPath(path)) {
      writeOwnerInboxPreflight(input.response, input.origin);
      return;
    }
    if (path === undefined || (method !== "GET" && method !== "POST")) {
      input.request.resume();
      writeDashboardError(input.response, { status: 404, code: DASHBOARD_ERROR_CODES.NOT_FOUND, requestId });
      return;
    }
    if (await tryHandleDashboardApi({
      db: input.db,
      model: input.model,
      terminals: input.terminals,
      url: input.request.url,
      path,
      request: input.request,
      response: input.response,
      requestId,
      hub: input.hub,
      session: input.session,
      origin: input.origin,
      clock: input.clock,
      capabilityProbe: input.capabilityProbe,
      secondBrainProbe: input.secondBrainProbe,
      planner: input.planner,
      memoryLifecycle: input.memoryLifecycle,
      executorFactory: input.executorFactory,
      memoryRuntime: input.memoryRuntime,
      remoteApproval: input.remoteApproval,
      ownerInbox: input.ownerInbox,
      assertionCheck: input.assertionCheck,
      enrollmentCheck: input.enrollmentCheck,
      now: input.clock(),
      workboardActions: input.workboardActions,
      priceFinance: input.priceFinance,
      mailCandidates: input.mailCandidates,
      mailSource: input.mailSource,
    })) {
      return;
    }
    if (path === "/api" || path.startsWith("/api/") || method !== "GET") {
      input.request.resume();
      writeDashboardError(input.response, { status: 404, code: DASHBOARD_ERROR_CODES.NOT_FOUND, requestId });
      return;
    }
    if (isAssetRequest(input.request.url, path) || hasFileNameExtension(path)) {
      const relativePath = safeAssetRelative(input.request.url, path);
      if (relativePath === undefined || !writeStaticAsset({
        response: input.response,
        staticRoot: input.staticRoot,
        relativePath,
        requestId,
      })) {
        writeDashboardError(input.response, { status: 404, code: DASHBOARD_ERROR_CODES.NOT_FOUND, requestId });
      }
      return;
    }
    writeDashboardHtml(input.response, { status: 200, body: readStaticIndex(input.staticRoot), requestId });
  } catch (error) {
    if (input.response.headersSent) {
      input.response.destroy();
      return;
    }
    if (error instanceof JarvisError && error.code === "MEMORY_SURFACE_READ_CHANGED") {
      writeDashboardError(input.response, { status: 409, code: error.code, requestId });
      return;
    }
    if (error instanceof JarvisError && (error.code === "AUTHORITY_NOT_READY"
      || error.code === "MEMORY_PROJECTION_AUTHORITY_NOT_READY")) {
      writeDashboardError(input.response, {
        status: 503,
        code: error.code,
        requestId,
      });
      return;
    }
    writeDashboardError(input.response, { status: 500, code: DASHBOARD_ERROR_CODES.INTERNAL_ERROR, requestId });
  }
}
