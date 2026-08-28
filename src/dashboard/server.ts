import { realpathSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { BoundSocket } from "node:net";

declare module "node:net" {
  export class BoundSocket {
    constructor(options?: { readonly host?: string; readonly port?: number });
    address(): { address: string; family: string; port: number };
    close(): void;
  }
}
import type { CapabilityProbe } from "../capabilities.js";
import type { SecondBrainReadinessProbe } from "../second-brain-readiness.js";
import { JarvisError, type AuthorityDb } from "../db.js";
import type { OrcaRunner } from "../orca.js";
import { tryHandleDashboardApi } from "./api-routes.js";
import { createDashboardEvents, type ReconcileHub } from "./events.js";
import {
  createRequestId,
  DASHBOARD_ERROR_CODES,
  isLoopbackHostHeader,
  writeDashboardError,
  writeDashboardHtml,
} from "./http.js";
import type { TeamProposalPlanner } from "./proposal-service.js";
import { DashboardReadModel } from "./read-model.js";
import { createDashboardSession, type DashboardSessionStore } from "./session.js";
import {
  hasFileNameExtension,
  isAssetRequest,
  readStaticIndex,
  requestPath,
  safeAssetRelative,
  writeStaticAsset,
} from "./static-assets.js";
import { DashboardTerminalReader } from "./terminal-reader.js";

const LOOPBACK_HOST = "127.0.0.1";

export type DashboardAddress = {
  readonly host: string;
  readonly port: number;
  readonly family: string;
};

export type DashboardServer = {
  readonly address: DashboardAddress;
  publish(topics: readonly string[]): void;
  close(): void;
};

export type DashboardServerOptions = {
  readonly db: AuthorityDb;
  readonly staticRoot: string;
  readonly host: string;
  readonly port: number;
  readonly orcaRunner?: OrcaRunner;
  readonly capabilityProbe?: CapabilityProbe;
  readonly secondBrainProbe?: SecondBrainReadinessProbe;
  readonly planner?: TeamProposalPlanner;
  readonly clock?: () => Date;
};

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
};

export function createDashboardServer(options: DashboardServerOptions): DashboardServer & {
  readonly address: { readonly host: string; readonly port: number; readonly family: "IPv4" };
} {
  if (options.host !== LOOPBACK_HOST) throw new JarvisError("LOCAL_SESSION_REQUIRED");
  if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535) {
    throw new JarvisError("VALIDATION_ERROR");
  }
  realpathSync(options.staticRoot);
  const model = new DashboardReadModel(options.db, options.secondBrainProbe);
  const terminals = new DashboardTerminalReader(model, options.orcaRunner);
  const events = createDashboardEvents(options.db);
  const session = createDashboardSession();
  const clock = options.clock ?? (() => new Date());
  const bind = { origin: `http://${LOOPBACK_HOST}:0` };
  const bound = new BoundSocket({ host: LOOPBACK_HOST, port: options.port });
  const httpServer = createServer((request, response) => {
    void handleRequest({
      db: options.db,
      model,
      terminals,
      staticRoot: options.staticRoot,
      request,
      response,
      hub: events.hub,
      session,
      origin: bind.origin,
      clock,
      capabilityProbe: options.capabilityProbe,
      secondBrainProbe: options.secondBrainProbe,
      planner: options.planner,
    });
  });
  httpServer.listen(bound);
  const boundAddress = httpServer.address();
  if (boundAddress === null || typeof boundAddress === "string" || boundAddress.family !== "IPv4" || boundAddress.address !== LOOPBACK_HOST) {
    events.close();
    httpServer.closeAllConnections();
    httpServer.close();
    throw new JarvisError("LOCAL_SESSION_REQUIRED");
  }
  bind.origin = `http://${LOOPBACK_HOST}:${boundAddress.port}`;
  return {
    address: { host: LOOPBACK_HOST, port: boundAddress.port, family: "IPv4" },
    publish(topics: readonly string[]): void { events.hub.publish(topics); },
    close(): void { events.close(); httpServer.closeAllConnections(); httpServer.close(); },
  };
}

async function handleRequest(input: RequestContext): Promise<void> {
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
    if (error instanceof JarvisError && error.code === "AUTHORITY_NOT_READY") {
      writeDashboardError(input.response, {
        status: 503,
        code: DASHBOARD_ERROR_CODES.AUTHORITY_NOT_READY,
        requestId,
      });
      return;
    }
    writeDashboardError(input.response, { status: 500, code: DASHBOARD_ERROR_CODES.INTERNAL_ERROR, requestId });
  }
}
