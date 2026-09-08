import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { createServer } from "node:http";
import { BoundSocket } from "node:net";
import { createPhoneGatewaySessionStore } from "./dashboard/phone-session.js";
import {
  LOOPBACK,
  PHONE_GATEWAY_PORT,
  PHONE_ERROR_CODES,
  PhoneGatewayError,
  type PhoneErrorCode,
  type PhoneGatewayConfig,
} from "./phone-gateway-protocol.js";
import { parseUpstream } from "./phone-gateway-config.js";
import { createPhoneAuthorityReadAdapter, createPhoneRateLimiter } from "./phone-gateway-adapter.js";
import { loadAssetNames, writePhoneGatewayError } from "./phone-gateway-http.js";
import { dispatchRequest } from "./phone-gateway-dispatch.js";
import type { PhoneGatewayRequestCtx } from "./phone-gateway-request-ctx.js";
import { createPhoneMemoryContext, type PhoneMemoryContextOptions } from "./phone-memory-context.js";

export type PhoneGatewayServer = {
  readonly address: { readonly host: "127.0.0.1"; readonly port: number; readonly family: "IPv4" };
  close(): void;
};

export function createPhoneGatewayServer(options: {
  readonly host: string;
  readonly port: number;
  readonly upstream: string;
  readonly staticRoot: string;
  readonly config: PhoneGatewayConfig;
  readonly now?: () => number;
  readonly audit?: (line: string) => void;
  readonly memoryContext?: PhoneMemoryContextOptions;
}): PhoneGatewayServer {
  if (options.host !== LOOPBACK) throw new PhoneGatewayError(PHONE_ERROR_CODES.PHONE_NOT_READY);
  if (options.port !== 0 && options.port !== PHONE_GATEWAY_PORT) throw new PhoneGatewayError(PHONE_ERROR_CODES.PHONE_NOT_READY);
  const upstreamUrl = parseUpstream(options.upstream);
  if (upstreamUrl === undefined) throw new PhoneGatewayError(PHONE_ERROR_CODES.PHONE_NOT_READY);
  const staticRoot = realpathSync(options.staticRoot);
  const assets = loadAssetNames(staticRoot);
  const now = options.now ?? Date.now;
  const memoryContext = options.memoryContext === undefined ? undefined
    : createPhoneMemoryContext(options.memoryContext, () => new Date(now()));
  const sessions = createPhoneGatewaySessionStore({ key: options.config.sessionKey, now });
  const limiter = createPhoneRateLimiter({ now });
  const adapter = createPhoneAuthorityReadAdapter({ upstream: upstreamUrl });
  void adapter.ready();
  const audit = options.audit ?? ((line: string) => { process.stdout.write(`${line}\n`); });
  const bound = new BoundSocket({ host: LOOPBACK, port: options.port });
  const httpServer = createServer((request, response) => {
    void handleRequest({
      request, response, config: options.config, sessions, limiter, adapter,
      staticRoot, assets, now, audit, upstream: upstreamUrl,
      memoryContext, memoryAgentId: options.memoryContext?.agent_id,
    });
  });
  httpServer.headersTimeout = 5000;
  httpServer.requestTimeout = 15_000;
  httpServer.keepAliveTimeout = 5000;
  httpServer.maxRequestsPerSocket = 4;
  httpServer.listen(bound);
  const boundAddress = httpServer.address();
  if (boundAddress === null || typeof boundAddress === "string" || boundAddress.family !== "IPv4"
    || boundAddress.address !== LOOPBACK) {
    httpServer.closeAllConnections();
    httpServer.close();
    throw new PhoneGatewayError(PHONE_ERROR_CODES.PHONE_NOT_READY);
  }
  return {
    address: { host: LOOPBACK, port: boundAddress.port, family: "IPv4" },
    close(): void { httpServer.closeAllConnections(); httpServer.close(); },
  };
}

async function handleRequest(ctx: PhoneGatewayRequestCtx): Promise<void> {
  const started = Date.now();
  const requestId = randomUUID();
  let routeClass = "denied";
  let outcome = "rejected";
  let code: PhoneErrorCode | "ok" = PHONE_ERROR_CODES.PHONE_REQUEST_INVALID;
  let status = 400;
  let ownerHex: string | null = null;
  const finish = (): void => {
    ctx.audit(JSON.stringify({
      schema_version: 1, event: "phone_gateway_request", request_id: requestId,
      occurred_at: new Date(ctx.now()).toISOString(), route_class: routeClass, outcome, code, status,
      duration_bucket: durationBucket(Date.now() - started), owner_digest16: ownerHex,
    }));
  };
  try {
    await dispatchRequest(ctx, requestId, (update) => {
      routeClass = update.routeClass ?? routeClass;
      outcome = update.outcome ?? outcome;
      code = update.code ?? code;
      status = update.status ?? status;
      ownerHex = update.ownerHex ?? ownerHex;
    });
  } catch (error) {
    if (error instanceof Error && ctx.response.headersSent) { ctx.response.destroy(); finish(); return; }
    if (ctx.response.headersSent) { ctx.response.destroy(); finish(); return; }
    code = PHONE_ERROR_CODES.PHONE_UPSTREAM_INVALID; status = 502;
    writePhoneGatewayError(ctx.response, { code, requestId });
  }
  finish();
}

function durationBucket(ms: number): "lt100ms" | "lt1s" | "lt10s" | "ge10s" {
  if (ms < 100) return "lt100ms";
  if (ms < 1000) return "lt1s";
  if (ms < 10_000) return "lt10s";
  return "ge10s";
}
