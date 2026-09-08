import { serializeCookie } from "./dashboard/phone-session.js";
import {
  CSRF_HEADER,
  ERROR_STATUS,
  PHONE_ERROR_CODES,
} from "./phone-gateway-protocol.js";
import { authenticateTailnetOwner, headerValues, isTrustedServeRequest } from "./phone-gateway-config.js";
import { matchPhoneRoute } from "./phone-gateway-routes.js";
import { phoneHtml, retryAfter, writeAsset, writeHtml, writeJson, writePhoneGatewayError } from "./phone-gateway-http.js";
import { readPostBody, validateMemoryBody } from "./phone-gateway-body.js";
import type { DispatchUpdate, PhoneGatewayRequestCtx } from "./phone-gateway-request-ctx.js";

export async function handleOwnerRequest(
  ctx: PhoneGatewayRequestCtx,
  method: string,
  path: string,
  rawUrl: string,
  requestId: string,
  update: (value: DispatchUpdate) => void,
): Promise<void> {
  const trusted = isTrustedServeRequest(ctx.request, ctx.config.publicHost);
  if (!trusted.ok) {
    writePhoneGatewayError(ctx.response, { code: trusted.code, requestId });
    update({ code: trusted.code, status: ERROR_STATUS[trusted.code] });
    return;
  }
  const principal = authenticateTailnetOwner(trusted.login, ctx.config.ownerLogin);
  if (!principal.ok) {
    writePhoneGatewayError(ctx.response, { code: principal.code, requestId });
    update({ code: principal.code, status: ERROR_STATUS[principal.code] });
    return;
  }
  update({ ownerHex: ctx.config.ownerDigest.toString("hex").slice(0, 16) });
  const origin = readOrigin(ctx.request.rawHeaders);
  const unsafe = method !== "GET" && method !== "HEAD";
  if (origin.kind === "bad" || (origin.kind === "ok" && origin.value !== ctx.config.publicOrigin)
    || (unsafe && origin.kind !== "ok")) {
    writePhoneGatewayError(ctx.response, { code: PHONE_ERROR_CODES.PHONE_ORIGIN_FORBIDDEN, requestId });
    update({ code: PHONE_ERROR_CODES.PHONE_ORIGIN_FORBIDDEN, status: 403 });
    return;
  }
  await handleAuthedRoute(ctx, method, path, rawUrl, requestId, update);
}

async function handleAuthedRoute(
  ctx: PhoneGatewayRequestCtx,
  method: string,
  path: string,
  rawUrl: string,
  requestId: string,
  update: (value: DispatchUpdate) => void,
): Promise<void> {
  const cookieHeaders = headerValues(ctx.request.rawHeaders, "cookie");
  if (cookieHeaders.length > 1) {
    ctx.response.setHeader("Set-Cookie", ctx.sessions.expireCookie());
    writePhoneGatewayError(ctx.response, { code: PHONE_ERROR_CODES.PHONE_SESSION_REQUIRED, requestId });
    update({ code: PHONE_ERROR_CODES.PHONE_SESSION_REQUIRED, status: 401 });
    return;
  }
  const auth = ctx.sessions.authenticate(cookieHeaders[0], ctx.config.ownerDigest);
  const matched = matchPhoneRoute({ method, path, rawUrl });
  if (matched.kind === "invalid") {
    writePhoneGatewayError(ctx.response, { code: PHONE_ERROR_CODES.PHONE_REQUEST_INVALID, requestId });
    update({ code: PHONE_ERROR_CODES.PHONE_REQUEST_INVALID, status: 400 });
    return;
  }
  if (matched.kind === "method_forbidden") {
    writePhoneGatewayError(ctx.response, { code: PHONE_ERROR_CODES.PHONE_METHOD_FORBIDDEN, requestId });
    update({ code: PHONE_ERROR_CODES.PHONE_METHOD_FORBIDDEN, status: 403 });
    return;
  }
  if (matched.kind === "not_found") {
    writePhoneGatewayError(ctx.response, { code: PHONE_ERROR_CODES.PHONE_ROUTE_NOT_FOUND, requestId });
    update({ code: PHONE_ERROR_CODES.PHONE_ROUTE_NOT_FOUND, status: 404 });
    return;
  }
  update({ routeClass: matched.routeClass });
  const ownerHex = ctx.config.ownerDigest.toString("hex").slice(0, 16);
  if (auth.kind !== "ok") {
    const limited = ctx.limiter.takePreSession(ownerHex);
    if (!limited.ok) {
      retryAfter(ctx.response, limited.retryAfter);
      writePhoneGatewayError(ctx.response, { code: PHONE_ERROR_CODES.PHONE_RATE_LIMITED, requestId });
      update({ code: PHONE_ERROR_CODES.PHONE_RATE_LIMITED, status: 429 });
      return;
    }
  } else {
    const limited = ctx.limiter.takeSession(auth.idHmac.toString("hex"));
    if (!limited.ok) {
      retryAfter(ctx.response, limited.retryAfter);
      writePhoneGatewayError(ctx.response, { code: PHONE_ERROR_CODES.PHONE_RATE_LIMITED, requestId });
      update({ code: PHONE_ERROR_CODES.PHONE_RATE_LIMITED, status: 429 });
      return;
    }
  }
  if (matched.routeClass === "session") {
    const issued = ctx.sessions.issue(ctx.config.ownerDigest);
    if (issued.kind === "capacity") {
      writePhoneGatewayError(ctx.response, { code: PHONE_ERROR_CODES.PHONE_CAPACITY_EXCEEDED, requestId });
      update({ code: PHONE_ERROR_CODES.PHONE_CAPACITY_EXCEEDED, status: 429 });
      return;
    }
    ctx.response.setHeader("Set-Cookie", issued.setCookie);
    writeJson(ctx.response, 200, requestId, {
      schema_version: 1, csrf_token: issued.csrfToken, expires_at: new Date(issued.expiresAt).toISOString(),
    }, true);
    update({ outcome: "allowed", code: "ok", status: 200 });
    return;
  }
  if (auth.kind !== "ok") {
    ctx.response.setHeader("Set-Cookie", ctx.sessions.expireCookie());
    writePhoneGatewayError(ctx.response, { code: PHONE_ERROR_CODES.PHONE_SESSION_REQUIRED, requestId });
    update({ code: PHONE_ERROR_CODES.PHONE_SESSION_REQUIRED, status: 401 });
    return;
  }
  if (matched.needsCsrf) {
    const csrfValues = headerValues(ctx.request.rawHeaders, CSRF_HEADER);
    if (csrfValues.length !== 1 || csrfValues[0] === undefined || !ctx.sessions.csrfMatches(auth.csrfHmac, csrfValues[0])) {
      writePhoneGatewayError(ctx.response, { code: PHONE_ERROR_CODES.PHONE_CSRF_REQUIRED, requestId });
      update({ code: PHONE_ERROR_CODES.PHONE_CSRF_REQUIRED, status: 403 });
      return;
    }
  }
  await serveMatchedRoute(ctx, method, path, matched, auth.idHmac, cookieHeaders[0], requestId, update);
}

async function serveMatchedRoute(
  ctx: PhoneGatewayRequestCtx,
  method: string,
  path: string,
  matched: Extract<ReturnType<typeof matchPhoneRoute>, { readonly kind: "ok" }>,
  idHmac: Buffer,
  cookieHeader: string | undefined,
  requestId: string,
  update: (value: DispatchUpdate) => void,
): Promise<void> {
  const isAuthenticated = (): boolean => {
    const current = ctx.sessions.authenticate(cookieHeader, ctx.config.ownerDigest);
    return current.kind === "ok" && current.idHmac.equals(idHmac);
  };
  const rejectAuthentication = (): false => {
    ctx.response.setHeader("Set-Cookie", ctx.sessions.expireCookie());
    writePhoneGatewayError(ctx.response, { code: PHONE_ERROR_CODES.PHONE_SESSION_REQUIRED, requestId });
    update({ code: PHONE_ERROR_CODES.PHONE_SESSION_REQUIRED, status: 401, outcome: "rejected" });
    return false;
  };
  const stillAuthenticated = (): boolean => isAuthenticated() || rejectAuthentication();
  const refreshCookie = (): void => {
    const refreshed = ctx.sessions.touch(idHmac);
    if (refreshed !== undefined) {
      ctx.response.setHeader("Set-Cookie", serializeCookie(cookieId(cookieHeader), refreshed.maxAge));
    }
  };
  if (matched.routeClass === "shell") {
    refreshCookie();
    writeHtml(ctx.response, requestId, phoneHtml(path === "/memory" ? "Memory" : "Today"));
    update({ outcome: "allowed", code: "ok", status: 200 });
    return;
  }
  if (matched.routeClass === "asset") {
    refreshCookie();
    if (!writeAsset(ctx.response, { path, requestId, staticRoot: ctx.staticRoot, assets: ctx.assets })) {
      writePhoneGatewayError(ctx.response, { code: PHONE_ERROR_CODES.PHONE_ROUTE_NOT_FOUND, requestId });
      update({ code: PHONE_ERROR_CODES.PHONE_ROUTE_NOT_FOUND, status: 404 });
      return;
    }
    update({ outcome: "allowed", code: "ok", status: 200 });
    return;
  }
  let body: Buffer | undefined;
  if (method === "POST") {
    const parsed = await readPostBody(ctx.request);
    if (parsed.kind !== "ok") {
      writePhoneGatewayError(ctx.response, { status: parsed.status, code: parsed.code, requestId });
      update({ code: parsed.code, status: parsed.status });
      return;
    }
    if (!validateMemoryBody(path, parsed.buffer)) {
      writePhoneGatewayError(ctx.response, { code: PHONE_ERROR_CODES.PHONE_REQUEST_INVALID, requestId });
      update({ code: PHONE_ERROR_CODES.PHONE_REQUEST_INVALID, status: 400 });
      return;
    }
    body = parsed.buffer;
  }
  // Body intake may outlive the authenticated session. Do not start a read
  // with stale authentication, or return its contents after expiry/revocation.
  if (!stillAuthenticated()) return;
  const proxied = await ctx.adapter.proxy({
    isAuthenticated,
    method: method === "POST" ? "POST" : "GET", path: matched.path, query: matched.query,
    body, responseCap: matched.responseCap,
  });
  if (proxied.kind === "unauthenticated") { rejectAuthentication(); return; }
  if (!stillAuthenticated()) return;
  if (proxied.kind === "too_large") {
    writePhoneGatewayError(ctx.response, { code: PHONE_ERROR_CODES.PHONE_RESPONSE_TOO_LARGE, requestId });
    update({ code: PHONE_ERROR_CODES.PHONE_RESPONSE_TOO_LARGE, status: 413, outcome: "rejected" });
    return;
  }
  if (proxied.kind === "unavailable") {
    writePhoneGatewayError(ctx.response, { code: PHONE_ERROR_CODES.PHONE_UPSTREAM_UNAVAILABLE, requestId });
    update({ code: PHONE_ERROR_CODES.PHONE_UPSTREAM_UNAVAILABLE, status: 503, outcome: "upstream_unavailable" });
    return;
  }
  if (proxied.kind !== "ok") {
    writePhoneGatewayError(ctx.response, { code: PHONE_ERROR_CODES.PHONE_UPSTREAM_INVALID, requestId });
    update({ code: PHONE_ERROR_CODES.PHONE_UPSTREAM_INVALID, status: 502, outcome: "upstream_unavailable" });
    return;
  }
  refreshCookie();
  writeJson(ctx.response, proxied.status, requestId, proxied.body, true);
  update({ outcome: "allowed", code: "ok", status: proxied.status });
}

function readOrigin(rawHeaders: readonly string[]):
  | { readonly kind: "absent" }
  | { readonly kind: "ok"; readonly value: string }
  | { readonly kind: "bad" } {
  const values = headerValues(rawHeaders, "origin");
  if (values.length === 0) return { kind: "absent" };
  if (values.length !== 1 || values[0] === undefined || values[0] === "null") return { kind: "bad" };
  return { kind: "ok", value: values[0] };
}

function cookieId(header: string | undefined): string {
  if (header === undefined) return "";
  const match = /__Host-jarvis-phone=([^;]+)/.exec(header);
  return match?.[1] ?? "";
}
