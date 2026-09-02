import type { IncomingMessage } from "node:http";
import { PHONE_ERROR_CODES, PHONE_GATEWAY_LIMITS } from "./phone-gateway-protocol.js";
import { headerValues } from "./phone-gateway-config.js";
import { writeJson, writePhoneGatewayError } from "./phone-gateway-http.js";
import { handleOwnerRequest } from "./phone-gateway-owner.js";
import type { DispatchUpdate, PhoneGatewayRequestCtx } from "./phone-gateway-request-ctx.js";

export async function dispatchRequest(
  ctx: PhoneGatewayRequestCtx,
  requestId: string,
  update: (value: DispatchUpdate) => void,
): Promise<void> {
  if (!withinHeaderBudget(ctx.request)) {
    writePhoneGatewayError(ctx.response, { code: PHONE_ERROR_CODES.PHONE_HEADERS_TOO_LARGE, requestId });
    update({ code: PHONE_ERROR_CODES.PHONE_HEADERS_TOO_LARGE, status: 413 });
    return;
  }
  const method = ctx.request.method ?? "";
  const rawUrl = ctx.request.url ?? "/";
  const path = normalizePath(rawUrl);
  if (path === undefined) {
    writePhoneGatewayError(ctx.response, { code: PHONE_ERROR_CODES.PHONE_REQUEST_INVALID, requestId });
    return;
  }
  if ((method === "GET" || method === "HEAD") && hasForbiddenGetBody(ctx.request)) {
    writePhoneGatewayError(ctx.response, { code: PHONE_ERROR_CODES.PHONE_BODY_FORBIDDEN, requestId });
    update({ code: PHONE_ERROR_CODES.PHONE_BODY_FORBIDDEN, status: 400 });
    return;
  }
  if ((path === "/healthz" || path === "/readyz") && (method === "GET" || method === "HEAD")) {
    await handleProbe(ctx, path, requestId, update);
    return;
  }
  await handleOwnerRequest(ctx, method, path, rawUrl, requestId, update);
}

async function handleProbe(
  ctx: PhoneGatewayRequestCtx,
  path: string,
  requestId: string,
  update: (value: DispatchUpdate) => void,
): Promise<void> {
  if (path === "/healthz") {
    update({ routeClass: "health", outcome: "allowed", code: "ok", status: 200 });
    writeJson(ctx.response, 200, requestId, { schema_version: 1, status: "ok" }, false);
    return;
  }
  const ready = await ctx.adapter.ready() && await ctx.adapter.probeHealth();
  update({ routeClass: "readiness" });
  if (!ready) {
    writePhoneGatewayError(ctx.response, { code: PHONE_ERROR_CODES.PHONE_NOT_READY, requestId });
    update({ code: PHONE_ERROR_CODES.PHONE_NOT_READY, status: 503, outcome: "upstream_unavailable" });
    return;
  }
  update({ outcome: "allowed", code: "ok", status: 200 });
  writeJson(ctx.response, 200, requestId, { schema_version: 1, status: "ok" }, false);
}

function normalizePath(rawUrl: string): string | undefined {
  try {
    const pathname = decodeURIComponent(new URL(rawUrl, "http://127.0.0.1").pathname);
    if (pathname.includes("\0") || pathname.includes("\\") || pathname.includes("%")) return undefined;
    const parts: string[] = [];
    for (const part of pathname.split("/")) {
      if (part === "" || part === ".") continue;
      if (part === "..") return undefined;
      parts.push(part);
    }
    return `/${parts.join("/")}`;
  } catch (error) {
    if (error instanceof URIError || error instanceof TypeError) return undefined;
    throw error;
  }
}

function withinHeaderBudget(request: IncomingMessage): boolean {
  const url = request.url ?? "";
  if (Buffer.byteLength(`${request.method ?? ""} ${url}`) > PHONE_GATEWAY_LIMITS.requestLine) return false;
  let total = 0;
  for (const value of request.rawHeaders) {
    const size = Buffer.byteLength(value);
    if (size > PHONE_GATEWAY_LIMITS.header) return false;
    total += size;
  }
  return total <= PHONE_GATEWAY_LIMITS.headers;
}

function hasForbiddenGetBody(request: IncomingMessage): boolean {
  if (headerValues(request.rawHeaders, "transfer-encoding").length > 0) return true;
  const length = headerValues(request.rawHeaders, "content-length");
  if (length.length > 1) return true;
  if (length.length === 1 && length[0] !== "0") return true;
  return false;
}
