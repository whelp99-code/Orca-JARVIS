import { randomBytes } from "node:crypto";
import { request as httpRequest } from "node:http";
import { gatewaySessionDigest, ingressMac, sha256Prefixed } from "./remote-approval-crypto.js";
import { LOOPBACK, PHONE_ERROR_CODES, PHONE_GATEWAY_LIMITS } from "./phone-gateway-protocol.js";
import { writeHtml, writeJson, writePhoneGatewayError } from "./phone-gateway-http.js";
import type { DispatchUpdate, PhoneGatewayRequestCtx } from "./phone-gateway-request-ctx.js";
import type { PhoneRouteMatch } from "./phone-gateway-protocol.js";

const PASSTHROUGH = new Set([200, 400, 401, 403, 404, 409, 429, 503]);

export async function servePhoneRemoteRoute(
  ctx: PhoneGatewayRequestCtx,
  method: string,
  path: string,
  matched: Extract<PhoneRouteMatch, { readonly kind: "ok" }>,
  isAuthenticated: () => boolean,
  stillAuthenticated: () => boolean,
  refreshCookie: () => void,
  requestId: string,
  update: (value: DispatchUpdate) => void,
): Promise<void> {
  if (method === "OPTIONS" && path.startsWith("/api/v1/owner-inbox")) {
    ctx.response.writeHead(204, {
      Allow: "GET, POST, OPTIONS",
      "Access-Control-Allow-Origin": ctx.config.publicOrigin,
      "Access-Control-Allow-Credentials": "true",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "content-type, x-jarvis-csrf",
    });
    ctx.response.end();
    update({ outcome: "allowed", code: "ok", status: 204 });
    return;
  }
  if (matched.routeClass === "security") {
    const html = await proxyDocument(ctx.upstream, path);
    if (!stillAuthenticated()) return;
    if (html === undefined) {
      writePhoneGatewayError(ctx.response, { code: PHONE_ERROR_CODES.PHONE_UPSTREAM_UNAVAILABLE, requestId });
      update({ code: PHONE_ERROR_CODES.PHONE_UPSTREAM_UNAVAILABLE, status: 503, outcome: "upstream_unavailable" });
      return;
    }
    refreshCookie();
    const marked = html.includes("jarvis-phone-mode")
      ? html
      : html.replace("<head>", "<head><meta name=\"jarvis-phone-mode\" content=\"1\"/>");
    writeHtml(ctx.response, requestId, marked);
    update({ outcome: "allowed", code: "ok", status: 200 });
    return;
  }
  const body = method === "POST" ? await readJsonBody(ctx.request) : Buffer.alloc(0);
  if (body === undefined) {
    writePhoneGatewayError(ctx.response, { code: PHONE_ERROR_CODES.PHONE_REQUEST_INVALID, requestId });
    update({ code: PHONE_ERROR_CODES.PHONE_REQUEST_INVALID, status: 400 });
    return;
  }
  if (!stillAuthenticated() || !isAuthenticated()) return;
  const upstream = await proxySigned(ctx, method === "POST" ? "POST" : "GET", path, body);
  if (!stillAuthenticated()) return;
  if (upstream === undefined) {
    writePhoneGatewayError(ctx.response, { code: PHONE_ERROR_CODES.PHONE_UPSTREAM_UNAVAILABLE, requestId });
    update({ code: PHONE_ERROR_CODES.PHONE_UPSTREAM_UNAVAILABLE, status: 503, outcome: "upstream_unavailable" });
    return;
  }
  refreshCookie();
  writeJson(ctx.response, upstream.status, requestId, upstream.body, true);
  update({ outcome: upstream.status === 200 ? "allowed" : "rejected", code: "ok", status: upstream.status });
}

function signHeader(ctx: PhoneGatewayRequestCtx, method: "GET" | "POST", path: string, body: Uint8Array): string {
  const envelope = {
    body_digest: sha256Prefixed(Buffer.from(body)),
    issued_at: new Date(ctx.now()).toISOString(),
    method,
    nonce: randomBytes(24).toString("base64url"),
    origin: ctx.config.publicOrigin,
    path,
    schema_version: 1,
    session_digest: gatewaySessionDigest(ctx.config.sessionKey, ctx.config.ownerDigest.toString("hex")),
  };
  return `${Buffer.from(JSON.stringify(envelope)).toString("base64url")}.${ingressMac(ctx.config.sessionKey, envelope)}`;
}

async function proxySigned(
  ctx: PhoneGatewayRequestCtx,
  method: "GET" | "POST",
  path: string,
  body: Uint8Array,
): Promise<{ readonly status: number; readonly body: Record<string, unknown> } | undefined> {
  const url = new URL(ctx.upstream);
  const headers: Record<string, string> = {
    Accept: "application/json",
    Host: `${LOOPBACK}:${url.port}`,
    "x-jarvis-remote-ingress": signHeader(ctx, method, path, body),
  };
  if (method === "POST") {
    headers["Content-Type"] = "application/json; charset=utf-8";
    headers["Content-Length"] = String(body.byteLength);
  }
  const result = await rawRequest({
    host: LOOPBACK, port: Number(url.port), path, method, headers,
    body: Buffer.from(body), cap: PHONE_GATEWAY_LIMITS.jsonResponse,
  });
  if (result === undefined || !PASSTHROUGH.has(result.status)) return undefined;
  let parsed: unknown;
  try { parsed = JSON.parse(result.text); } catch (error) {
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
  if (typeof parsed !== "object" || parsed === null || Reflect.get(parsed, "schema_version") !== 1) return undefined;
  return { status: result.status, body: parsed as Record<string, unknown> };
}

async function proxyDocument(upstream: string, path: string): Promise<string | undefined> {
  const url = new URL(upstream);
  const result = await rawRequest({
    host: LOOPBACK, port: Number(url.port), path, method: "GET",
    headers: { Accept: "text/html", Host: `${LOOPBACK}:${url.port}` },
    body: Buffer.alloc(0), cap: PHONE_GATEWAY_LIMITS.html,
  });
  if (result === undefined || result.status !== 200 || !result.text.includes("<html")) return undefined;
  return result.text;
}

function rawRequest(input: {
  readonly host: string; readonly port: number; readonly path: string; readonly method: string;
  readonly headers: Record<string, string>; readonly body: Buffer; readonly cap: number;
}): Promise<{ readonly status: number; readonly text: string } | undefined> {
  return new Promise(resolve => {
    const req = httpRequest({
      host: input.host, port: input.port, path: input.path, method: input.method, headers: input.headers,
    }, response => {
      const chunks: Buffer[] = [];
      let size = 0;
      response.on("data", (chunk: Buffer | string) => {
        const piece = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
        size += piece.byteLength;
        if (size > input.cap) { response.destroy(); resolve(undefined); return; }
        chunks.push(piece);
      });
      response.on("end", () => {
        resolve({ status: response.statusCode ?? 0, text: Buffer.concat(chunks).toString("utf8") });
      });
    });
    req.setTimeout(PHONE_GATEWAY_LIMITS.totalTimeoutMs, () => { req.destroy(); resolve(undefined); });
    req.on("error", () => resolve(undefined));
    if (input.method === "POST") req.end(input.body);
    else req.end();
  });
}

async function readJsonBody(request: PhoneGatewayRequestCtx["request"]): Promise<Buffer | undefined> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const piece = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    size += piece.byteLength;
    if (size > PHONE_GATEWAY_LIMITS.postBody) return undefined;
    chunks.push(piece);
  }
  const body = Buffer.concat(chunks, size);
  if (body.byteLength === 0) return undefined;
  try {
    const parsed: unknown = JSON.parse(body.toString("utf8"));
    if (typeof parsed !== "object" || parsed === null || Reflect.get(parsed, "schema_version") !== 1) return undefined;
  } catch (error) {
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
  return body;
}
