import type { IncomingMessage, ServerResponse } from "node:http";
import type { CapabilityProbe } from "../capabilities.js";
import type { AuthorityDb } from "../db.js";
import type { MemoryLifecycleService } from "../memory-lifecycle-service-types.js";
import type { DashboardExecutorFactory } from "./authority-service.js";
import { tryHandleAuthorityPost } from "./authority-routes.js";
import type { ReconcileHub } from "./events.js";
import { DASHBOARD_ERROR_CODES, writeDashboardError } from "./http.js";
import { tryHandleMemoryMutation } from "./memory-mutation-routes.js";
import type { MemoryRuntime } from "./memory-runtime.js";
import { tryHandleNotificationDelivery } from "./notification-delivery-routes.js";
import { tryHandleProposalPreview } from "./proposal-routes.js";
import { tryHandleRecommendationAccept } from "./recommendation-action-routes.js";
import type { TeamProposalPlanner } from "./proposal-service.js";
import { readJsonPost, writePostBoundaryError } from "./request-boundary.js";
import type { DashboardSessionStore } from "./session.js";
import { tryHandleTaskCreate } from "./task-routes.js";

export type DashboardPostInput = {
  readonly db: AuthorityDb;
  readonly path: string;
  readonly request: IncomingMessage;
  readonly response: ServerResponse;
  readonly requestId: string;
  readonly hub: ReconcileHub;
  readonly session: DashboardSessionStore;
  readonly origin: string;
  readonly clock: () => Date;
  readonly capabilityProbe?: CapabilityProbe;
  readonly planner?: TeamProposalPlanner;
  readonly memoryLifecycle?: Pick<MemoryLifecycleService, "execute">;
  readonly executorFactory?: DashboardExecutorFactory;
  readonly memoryRuntime: MemoryRuntime;
};

export async function tryHandleDashboardPost(input: DashboardPostInput): Promise<boolean> {
  if (input.path !== "/api" && !input.path.startsWith("/api/")) return false;
  const parsed = await readJsonPost({
    request: input.request,
    session: input.session,
    origin: input.origin,
    path: input.path,
  });
  switch (parsed.kind) {
    case "rejected":
      writePostBoundaryError(input.response, input.requestId, parsed);
      return true;
    case "accepted":
      break;
    default:
      return assertNever(parsed);
  }
  if (await tryHandleMemoryMutation({ path: input.path, body: parsed.value,
    response: input.response, requestId: input.requestId, runtime: input.memoryRuntime,
    hub: input.hub })) return true;
  if (await tryHandleProposalPreview({
    db: input.db,
    path: input.path,
    request: input.request,
    response: input.response,
    requestId: input.requestId,
    body: parsed.value,
    capabilityProbe: input.capabilityProbe,
    planner: input.planner,
  })) {
    return true;
  }
  if (await tryHandleTaskCreate({
    db: input.db,
    path: input.path,
    request: input.request,
    response: input.response,
    requestId: input.requestId,
    body: parsed.value,
    hub: input.hub,
    clock: input.clock,
    capabilityProbe: input.capabilityProbe,
    planner: input.planner,
  })) {
    return true;
  }
  if (tryHandleRecommendationAccept({
    db: input.db,
    path: input.path,
    response: input.response,
    requestId: input.requestId,
    body: parsed.value,
    hub: input.hub,
    clock: input.clock,
    session: input.session,
  })) {
    return true;
  }
  if (tryHandleNotificationDelivery({
    db: input.db,
    path: input.path,
    body: parsed.value,
    response: input.response,
    requestId: input.requestId,
    hub: input.hub,
    session: input.session,
    clock: input.clock,
  })) {
    return true;
  }
  if (await tryHandleAuthorityPost({
    db: input.db,
    path: input.path,
    request: input.request,
    response: input.response,
    requestId: input.requestId,
    body: parsed.value,
    hub: input.hub,
    clock: input.clock,
    memoryLifecycle: input.memoryLifecycle,
    executorFactory: input.executorFactory,
  })) {
    return true;
  }
  writeDashboardError(input.response, {
    status: 404,
    code: DASHBOARD_ERROR_CODES.NOT_FOUND,
    requestId: input.requestId,
  });
  return true;
}

function assertNever(value: never): never {
  throw new Error(`unexpected dashboard post: ${JSON.stringify(value)}`);
}
