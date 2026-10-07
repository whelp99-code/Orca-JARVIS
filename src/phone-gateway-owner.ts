import { servePhoneMemoryProviderVerification, servePhoneMemoryReconciliation } from "./phone-memory-provider-route.js";
import { phoneRequestAuthentication } from "./phone-request-authentication.js";
import {
  CSRF_HEADER,
  ERROR_STATUS,
  PHONE_ERROR_CODES,
} from "./phone-gateway-protocol.js";
import { authenticateTailnetOwner, headerValues, isTrustedServeRequest } from "./phone-gateway-config.js";
import { readPhoneOrigin } from "./phone-gateway-origin.js";
import { matchPhoneRoute } from "./phone-gateway-routes.js";
import { writeOwnerInboxPreflight } from "./owner-inbox-preflight.js";
import { retryAfter, writeAsset, writeHtml, writeJson, writePhoneGatewayError } from "./phone-gateway-http.js";
import { bootstrapDocumentSession } from "./phone-gateway-navigation.js";
import { servePhoneRemoteRoute } from "./phone-gateway-remote.js";
import { readPostBody, validateMemoryBody } from "./phone-gateway-body.js";
import type { DispatchUpdate, PhoneGatewayRequestCtx } from "./phone-gateway-request-ctx.js";
import { createPhoneMemorySessionSource } from "./dashboard/memory-session-source.js";
import { phoneMemoryContextError } from "./phone-memory-context-error.js";

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
  const origin = readPhoneOrigin(ctx.request.rawHeaders);
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
  if (method === "OPTIONS" && path.startsWith("/api/v1/owner-inbox")) {
    writeOwnerInboxPreflight(ctx.response, ctx.config.publicOrigin);
    update({ outcome: "allowed", code: "ok", status: 204 });
    return;
  }
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
  const session = auth.kind === "ok"
    ? { idHmac: auth.idHmac, cookieHeader: cookieHeaders[0] }
    : bootstrapDocumentSession(ctx, method, matched.routeClass, requestId, update);
  if (session === undefined) return;
  if (matched.needsCsrf) {
    const csrfValues = headerValues(ctx.request.rawHeaders, CSRF_HEADER);
    if (auth.kind !== "ok" || csrfValues.length !== 1 || csrfValues[0] === undefined
      || !ctx.sessions.csrfMatches(auth.csrfHmac, csrfValues[0])) {
      writePhoneGatewayError(ctx.response, { code: PHONE_ERROR_CODES.PHONE_CSRF_REQUIRED, requestId });
      update({ code: PHONE_ERROR_CODES.PHONE_CSRF_REQUIRED, status: 403 });
      return;
    }
  }
  await serveMatchedRoute(ctx, method, path, matched, session.idHmac, session.cookieHeader, requestId, update);
}

async function serveMatchedRoute(ctx: PhoneGatewayRequestCtx, method: string, path: string,
  matched: Extract<ReturnType<typeof matchPhoneRoute>, { readonly kind: "ok" }>,
  idHmac: Buffer, cookieHeader: string | undefined, requestId: string,
  update: (value: DispatchUpdate) => void,
): Promise<void> {
  const { isAuthenticated, rejectAuthentication, stillAuthenticated, refreshCookie } =
    phoneRequestAuthentication(ctx, cookieHeader, idHmac, requestId, update);
  if (matched.routeClass === "security" || matched.routeClass === "remote_approval") {
    await servePhoneRemoteRoute(ctx, method, path, matched, isAuthenticated, stillAuthenticated, refreshCookie, requestId, update);
    return;
  }
  if (matched.routeClass === "shell") {
    if (ctx.document === undefined) {
      writePhoneGatewayError(ctx.response, { code: PHONE_ERROR_CODES.PHONE_NOT_READY, requestId });
      update({ code: PHONE_ERROR_CODES.PHONE_NOT_READY, status: 503 });
      return;
    }
    refreshCookie();
    writeHtml(ctx.response, requestId, ctx.document);
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
  if (matched.routeClass === "memory_capabilities") {
    writeJson(ctx.response, 200, requestId, { schema_version: 1,
      profile: ctx.memoryProfile ?? "scoped-record-read-v2", configured: ctx.memoryContext !== undefined,
      supported_operations: ["context"], writes_supported: false,
      authorization: "checked_per_request", readiness: "not_checked" }, true);
    update({ outcome: "allowed", code: "ok", status: 200 }); return;
  }
  if (matched.routeClass === "memory_reconcile") {
    await servePhoneMemoryReconciliation(ctx, cookieHeader, body, requestId, update, stillAuthenticated);
    return;
  }
  if (matched.routeClass === "memory_provider_verify") {
    await servePhoneMemoryProviderVerification(ctx, cookieHeader, body, requestId, update, stillAuthenticated);
    return;
  }
  if (matched.routeClass === "memory_context") {
    if (ctx.memoryContext === undefined || ctx.memoryAgentId === undefined || body === undefined) {
      writePhoneGatewayError(ctx.response, { code: PHONE_ERROR_CODES.PHONE_NOT_READY, requestId });
      update({ code: PHONE_ERROR_CODES.PHONE_NOT_READY, status: 503 }); return;
    }
    const session = createPhoneMemorySessionSource({ sessions: ctx.sessions, cookieHeader: () => cookieHeader,
      currentOwnerDigest: () => ctx.config.ownerDigest, agentId: ctx.memoryAgentId, now: ctx.now });
    let result;
    try { result = await ctx.memoryContext(body, session); }
    catch (error) {
      // Distinguish a lost login from a still-authenticated session with no grant.
      if (!stillAuthenticated()) return;
      const code = phoneMemoryContextError(error);
      if (code === undefined) throw error;
      if (code === PHONE_ERROR_CODES.PHONE_CAPACITY_EXCEEDED) retryAfter(ctx.response, 1);
      writePhoneGatewayError(ctx.response, { code, requestId });
      update({ code, status: ERROR_STATUS[code], outcome: "rejected" }); return;
    }
    if (!stillAuthenticated()) return;
    refreshCookie(); writeJson(ctx.response, 200, requestId, result, true);
    update({ outcome: "allowed", code: "ok", status: 200 }); return;
  }
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


