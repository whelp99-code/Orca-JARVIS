// allow: SIZE_OK — Task 34 frozen surface forbids extra production files; fail-closed phone request pipeline is one state machine.
import { createHash, randomUUID } from "node:crypto";
import { lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { BoundSocket } from "node:net";
import { basename, dirname, isAbsolute, join, sep } from "node:path";
import {
  createPhoneGatewaySessionStore,
  serializeCookie,
  type PhoneGatewaySessionStore,
} from "./dashboard/phone-session.js";

const LOOPBACK = "127.0.0.1" as const;
const CSRF_HEADER = "x-jarvis-csrf";
const FORBIDDEN_HEADERS = new Set([
  "forwarded", "x-forwarded-for", "x-forwarded-host", "x-forwarded-proto",
  "x-real-ip", "via", "proxy-authorization",
]);
const SECURITY = {
  "Strict-Transport-Security": "max-age=31536000",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
  "Content-Security-Policy": "default-src 'self'; base-uri 'none'; connect-src 'self'; form-action 'none'; frame-ancestors 'none'; img-src 'self' data:; object-src 'none'; script-src 'self'; style-src 'self'",
} as const;

export const PHONE_GATEWAY_LIMITS = {
  requestLine: 4096,
  headers: 16_384,
  header: 2048,
  cookie: 4096,
  postBody: 65_536,
  html: 262_144,
  asset: 2 * 1024 * 1024,
  sessionBootstrap: 4096,
  memoryDetailResponse: 32_768,
  jsonResponse: 65_536,
  sessions: 128,
  limiterEntries: 256,
  concurrentUpstream: 8,
  connectTimeoutMs: 1000,
  totalTimeoutMs: 10_000,
  healthTimeoutMs: 2000,
} as const;

export const PHONE_ERROR_CODES = {
  PHONE_REQUEST_INVALID: "PHONE_REQUEST_INVALID",
  PHONE_BODY_FORBIDDEN: "PHONE_BODY_FORBIDDEN",
  PHONE_IDENTITY_REQUIRED: "PHONE_IDENTITY_REQUIRED",
  PHONE_SESSION_REQUIRED: "PHONE_SESSION_REQUIRED",
  PHONE_PROXY_REQUIRED: "PHONE_PROXY_REQUIRED",
  PHONE_PRINCIPAL_FORBIDDEN: "PHONE_PRINCIPAL_FORBIDDEN",
  PHONE_HOST_FORBIDDEN: "PHONE_HOST_FORBIDDEN",
  PHONE_FORWARDED_HEADER_FORBIDDEN: "PHONE_FORWARDED_HEADER_FORBIDDEN",
  PHONE_ORIGIN_FORBIDDEN: "PHONE_ORIGIN_FORBIDDEN",
  PHONE_CSRF_REQUIRED: "PHONE_CSRF_REQUIRED",
  PHONE_METHOD_FORBIDDEN: "PHONE_METHOD_FORBIDDEN",
  PHONE_ROUTE_NOT_FOUND: "PHONE_ROUTE_NOT_FOUND",
  PHONE_HEADERS_TOO_LARGE: "PHONE_HEADERS_TOO_LARGE",
  PHONE_RESPONSE_TOO_LARGE: "PHONE_RESPONSE_TOO_LARGE",
  PHONE_RATE_LIMITED: "PHONE_RATE_LIMITED",
  PHONE_CAPACITY_EXCEEDED: "PHONE_CAPACITY_EXCEEDED",
  PHONE_UPSTREAM_INVALID: "PHONE_UPSTREAM_INVALID",
  PHONE_UPSTREAM_UNAVAILABLE: "PHONE_UPSTREAM_UNAVAILABLE",
  PHONE_NOT_READY: "PHONE_NOT_READY",
} as const;

export type PhoneErrorCode = (typeof PHONE_ERROR_CODES)[keyof typeof PHONE_ERROR_CODES];

const ERROR_STATUS: Record<PhoneErrorCode, number> = {
  PHONE_REQUEST_INVALID: 400,
  PHONE_BODY_FORBIDDEN: 400,
  PHONE_IDENTITY_REQUIRED: 401,
  PHONE_SESSION_REQUIRED: 401,
  PHONE_PROXY_REQUIRED: 403,
  PHONE_PRINCIPAL_FORBIDDEN: 403,
  PHONE_HOST_FORBIDDEN: 403,
  PHONE_FORWARDED_HEADER_FORBIDDEN: 403,
  PHONE_ORIGIN_FORBIDDEN: 403,
  PHONE_CSRF_REQUIRED: 403,
  PHONE_METHOD_FORBIDDEN: 403,
  PHONE_ROUTE_NOT_FOUND: 404,
  PHONE_HEADERS_TOO_LARGE: 413,
  PHONE_RESPONSE_TOO_LARGE: 413,
  PHONE_RATE_LIMITED: 429,
  PHONE_CAPACITY_EXCEEDED: 429,
  PHONE_UPSTREAM_INVALID: 502,
  PHONE_UPSTREAM_UNAVAILABLE: 503,
  PHONE_NOT_READY: 503,
};

export const PHONE_CORE_ROUTES = [
  { method: "GET", path: "/healthz", routeClass: "health", proxyBranch: undefined },
  { method: "GET", path: "/readyz", routeClass: "readiness", proxyBranch: undefined },
  { method: "GET", path: "/api/v1/phone/session", routeClass: "session", proxyBranch: undefined },
  { method: "GET", path: "/", routeClass: "shell", proxyBranch: undefined },
  { method: "GET", path: "/memory", routeClass: "shell", proxyBranch: undefined },
  { method: "GET", path: "/NOTICE-ARGO.txt", routeClass: "asset", proxyBranch: undefined },
  { method: "GET", path: "/assets/<manifest-owned-name>", routeClass: "asset", proxyBranch: undefined },
  { method: "GET", path: "/api/v1/today", routeClass: "today", proxyBranch: "today" },
  { method: "GET", path: "/api/v1/decision-inbox", routeClass: "today", proxyBranch: "decision-inbox" },
  { method: "GET", path: "/api/v1/notification-intents", routeClass: "today", proxyBranch: "notification-intents" },
  { method: "GET", path: "/api/v1/source-health", routeClass: "today", proxyBranch: "source-health" },
  { method: "GET", path: "/api/v1/recommendations/<safe-id>", routeClass: "today", proxyBranch: "recommendation" },
  { method: "GET", path: "/api/v1/contexts/<safe-id>/evidence", routeClass: "today", proxyBranch: "evidence" },
  { method: "POST", path: "/api/v1/memory/search", routeClass: "memory_search", proxyBranch: "memory_search" },
  { method: "POST", path: "/api/v1/memory/records/detail", routeClass: "memory_detail", proxyBranch: "memory_detail" },
  { method: "GET", path: "/api/v1/memory/conflicts", routeClass: "memory_conflicts", proxyBranch: "memory_conflicts" },
  { method: "GET", path: "/api/v1/memory/status", routeClass: "memory_status", proxyBranch: "memory_status" },
] as const;

export class PhoneGatewayError extends Error {
  readonly name = "PhoneGatewayError";
  constructor(readonly code: string) { super(code); }
}

export type PhoneGatewayConfig = {
  readonly publicOrigin: string;
  readonly publicHost: string;
  readonly ownerLogin: string;
  readonly sessionKey: Buffer;
  readonly ownerDigest: Buffer;
};

export type PhoneServeSpec = {
  readonly schema_version: 1;
  readonly exposure: "tailnet-only";
  readonly protocol: "https";
  readonly port: 443;
  readonly target: "http://127.0.0.1:4174";
  readonly funnel: false;
  readonly command_argv: readonly ["tailscale", "serve", "--https=443", "http://127.0.0.1:4174"];
};

export type PhoneRouteMatch =
  | {
    readonly kind: "ok";
    readonly routeClass: (typeof PHONE_CORE_ROUTES)[number]["routeClass"];
    readonly method: "GET" | "HEAD" | "POST";
    readonly path: string;
    readonly query: string;
    readonly responseCap: number;
    readonly needsSession: boolean;
    readonly needsCsrf: boolean;
    readonly proxy: boolean;
  }
  | { readonly kind: "not_found" }
  | { readonly kind: "method_forbidden" }
  | { readonly kind: "invalid" };

type ServeRequest = {
  readonly socket: { readonly remoteAddress?: string };
  readonly rawHeaders: readonly string[];
};

export function parsePhoneGatewayConfig(input: {
  readonly home: string;
  readonly envFile: string;
  readonly uid: number;
}): PhoneGatewayConfig {
  const home = realpathChecked(input.home);
  const configRoot = join(home, ".config", "orca-jarvis");
  const envBytes = readSecretFile(input.envFile, input.uid);
  if (!inside(configRoot, realpathChecked(input.envFile))) throw new PhoneGatewayError(PHONE_ERROR_CODES.PHONE_NOT_READY);
  const records = parseEnvRecords(envBytes.toString("utf8"));
  if (records === undefined) throw new PhoneGatewayError(PHONE_ERROR_CODES.PHONE_NOT_READY);
  const originRaw = records.get("JARVIS_PHONE_PUBLIC_ORIGIN");
  const login = records.get("JARVIS_PHONE_OWNER_LOGIN");
  const keyPath = records.get("JARVIS_PHONE_SESSION_KEY_FILE");
  if (originRaw === undefined || login === undefined || keyPath === undefined || records.size !== 3) {
    throw new PhoneGatewayError(PHONE_ERROR_CODES.PHONE_NOT_READY);
  }
  const origin = parseHttpsOrigin(originRaw);
  if (origin === undefined || !isWellFormedLogin(login)) throw new PhoneGatewayError(PHONE_ERROR_CODES.PHONE_NOT_READY);
  if (!isAbsolute(keyPath) || keyPath.includes("\0")) throw new PhoneGatewayError(PHONE_ERROR_CODES.PHONE_NOT_READY);
  const key = readSecretFile(keyPath, input.uid, 32);
  if (!inside(configRoot, realpathChecked(keyPath))) throw new PhoneGatewayError(PHONE_ERROR_CODES.PHONE_NOT_READY);
  return {
    publicOrigin: origin.origin,
    publicHost: origin.host,
    ownerLogin: login,
    sessionKey: key,
    ownerDigest: createHash("sha256").update(login).digest(),
  };
}

export function parsePhoneServeSpec(text: string): PhoneServeSpec {
  const value: unknown = JSON.parse(text);
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new PhoneGatewayError(PHONE_ERROR_CODES.PHONE_NOT_READY);
  const argv = Reflect.get(value, "command_argv");
  if (!Array.isArray(argv) || argv.length !== 4 || argv.some(item => typeof item !== "string")) {
    throw new PhoneGatewayError(PHONE_ERROR_CODES.PHONE_NOT_READY);
  }
  const spec = {
    schema_version: Reflect.get(value, "schema_version"),
    exposure: Reflect.get(value, "exposure"),
    protocol: Reflect.get(value, "protocol"),
    port: Reflect.get(value, "port"),
    target: Reflect.get(value, "target"),
    funnel: Reflect.get(value, "funnel"),
    command_argv: argv,
  };
  if (spec.schema_version !== 1 || spec.exposure !== "tailnet-only" || spec.protocol !== "https"
    || spec.port !== 443 || spec.target !== "http://127.0.0.1:4174" || spec.funnel !== false
    || spec.command_argv[0] !== "tailscale" || spec.command_argv[1] !== "serve"
    || spec.command_argv[2] !== "--https=443" || spec.command_argv[3] !== "http://127.0.0.1:4174"
    || spec.command_argv.join(" ").toLowerCase().includes("funnel")
    || Object.keys(value).length !== 7) {
    throw new PhoneGatewayError(PHONE_ERROR_CODES.PHONE_NOT_READY);
  }
  return {
    schema_version: 1, exposure: "tailnet-only", protocol: "https", port: 443,
    target: "http://127.0.0.1:4174", funnel: false,
    command_argv: ["tailscale", "serve", "--https=443", "http://127.0.0.1:4174"],
  };
}

export function isTrustedServeRequest(
  request: ServeRequest,
  expectedHost: string,
): { readonly ok: true; readonly login: string } | { readonly ok: false; readonly code: PhoneErrorCode } {
  if (request.socket.remoteAddress !== LOOPBACK) {
    return { ok: false, code: PHONE_ERROR_CODES.PHONE_PROXY_REQUIRED };
  }
  const hosts = headerValues(request.rawHeaders, "host");
  const logins = headerValues(request.rawHeaders, "tailscale-user-login");
  if (hosts.length !== 1 || hosts[0] !== expectedHost) return { ok: false, code: PHONE_ERROR_CODES.PHONE_HOST_FORBIDDEN };
  if (logins.length !== 1 || logins[0] === undefined || logins[0].length === 0) {
    return { ok: false, code: PHONE_ERROR_CODES.PHONE_IDENTITY_REQUIRED };
  }
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    const name = request.rawHeaders[index]?.toLowerCase();
    if (name !== undefined && FORBIDDEN_HEADERS.has(name)) {
      return { ok: false, code: PHONE_ERROR_CODES.PHONE_FORWARDED_HEADER_FORBIDDEN };
    }
  }
  return { ok: true, login: logins[0] };
}

export function authenticateTailnetOwner(
  login: string,
  expected: string,
): { readonly ok: true } | { readonly ok: false; readonly code: PhoneErrorCode } {
  if (login === expected) return { ok: true };
  if (isWellFormedLogin(login)) return { ok: false, code: PHONE_ERROR_CODES.PHONE_PRINCIPAL_FORBIDDEN };
  return { ok: false, code: PHONE_ERROR_CODES.PHONE_IDENTITY_REQUIRED };
}

export function matchPhoneRoute(input: {
  readonly method: string;
  readonly path: string;
  readonly rawUrl: string;
}): PhoneRouteMatch {
  if (input.path.includes("..") || input.path.includes("//") || input.path.includes("%") || input.path.includes("\\")) {
    return { kind: "not_found" };
  }
  const method = input.method;
  const known = knownMethods(input.path);
  if (known !== undefined && !known.includes(method)) return { kind: "method_forbidden" };
  const query = queryPart(input.rawUrl);
  if (query === undefined) return { kind: "invalid" };
  if (method === "GET" || method === "HEAD") {
    if (input.path === "/healthz" && query === "") return route("health", method, input.path, "", 64, false, false, false);
    if (input.path === "/readyz" && query === "") return route("readiness", method, input.path, "", 64, false, false, false);
  }
  if (method === "GET") {
    if (input.path === "/api/v1/phone/session" && query === "") return route("session", method, input.path, "", 1024, false, false, false);
    if ((input.path === "/" || input.path === "/memory") && query === "") {
      return route("shell", method, input.path, "", PHONE_GATEWAY_LIMITS.html, true, false, false);
    }
    if (input.path === "/NOTICE-ARGO.txt" && query === "") return route("asset", method, input.path, "", PHONE_GATEWAY_LIMITS.asset, true, false, false);
    const asset = assetName(input.path);
    if (asset !== undefined && query === "") return route("asset", method, input.path, "", PHONE_GATEWAY_LIMITS.asset, true, false, false);
    if (input.path === "/api/v1/today" && query === "") return route("today", method, input.path, "", PHONE_GATEWAY_LIMITS.jsonResponse, true, true, true);
    const list = matchList(input.path, query);
    if (list !== undefined) return list;
    const recommendation = matchId(input.path, "/api/v1/recommendations/");
    if (recommendation !== undefined && query === "") {
      return route("today", method, input.path, "", PHONE_GATEWAY_LIMITS.jsonResponse, true, true, true);
    }
    const evidence = matchEvidence(input.path, query);
    if (evidence !== undefined) return evidence;
    if (input.path === "/api/v1/memory/conflicts") {
      const limit = exactQuery(query, ["limit"]);
      const value = limit?.get("limit") ?? undefined;
      if (value === undefined || canonicalInt(value, 1, 32) === undefined) return { kind: "invalid" };
      return route("memory_conflicts", method, input.path, `?limit=${value}`, PHONE_GATEWAY_LIMITS.jsonResponse, true, true, true);
    }
    if (input.path === "/api/v1/memory/status" && query === "") {
      return route("memory_status", method, input.path, "", PHONE_GATEWAY_LIMITS.jsonResponse, true, true, true);
    }
  }
  if (method === "POST" && query === "") {
    if (input.path === "/api/v1/memory/search") {
      return route("memory_search", method, input.path, "", PHONE_GATEWAY_LIMITS.jsonResponse, true, true, true);
    }
    if (input.path === "/api/v1/memory/records/detail") {
      return route("memory_detail", method, input.path, "", PHONE_GATEWAY_LIMITS.memoryDetailResponse, true, true, true);
    }
  }
  return { kind: "not_found" };
}

export function createPhoneRateLimiter(input: { readonly now: () => number }): {
  takePreSession(id: string): { readonly ok: true } | { readonly ok: false; readonly retryAfter: number };
  takeSession(id: string): { readonly ok: true } | { readonly ok: false; readonly retryAfter: number };
} {
  const pre = new Map<string, Bucket>();
  const sessions = new Map<string, Bucket>();
  return {
    takePreSession(id: string) { return takeBucket(pre, id, 5, 5, input.now); },
    takeSession(id: string) { return takeBucket(sessions, id, 20, 60, input.now); },
  };
}

export function createPhoneAuthorityReadAdapter(input: { readonly upstream: string }): PhoneAuthorityReadAdapter {
  const upstream = input.upstream;
  const port = new URL(upstream).port;
  let csrf: string | undefined;
  let inflight: Promise<boolean> | undefined;
  let upstreamInflight = 0;
  const bootstrap = async (): Promise<boolean> => {
    const result = await upstreamJson({
      upstream, method: "GET", path: "/api/v1/session", headers: { Accept: "application/json" },
      cap: PHONE_GATEWAY_LIMITS.sessionBootstrap, timeoutMs: PHONE_GATEWAY_LIMITS.totalTimeoutMs,
    });
    if (result.kind !== "ok" || result.status !== 200) { csrf = undefined; return false; }
    const token = closedCsrf(result.value);
    if (token === undefined) { csrf = undefined; return false; }
    csrf = token;
    return true;
  };
  const ensure = async (): Promise<boolean> => {
    if (csrf !== undefined) return true;
    inflight ??= bootstrap().finally(() => { inflight = undefined; });
    return inflight;
  };
  return {
    async ready(): Promise<boolean> { return ensure(); },
    async probeHealth(): Promise<boolean> {
      const result = await upstreamJson({
        upstream, method: "GET", path: "/api/v1/health", headers: { Accept: "application/json" },
        cap: PHONE_GATEWAY_LIMITS.jsonResponse, timeoutMs: PHONE_GATEWAY_LIMITS.healthTimeoutMs,
      });
      if (result.kind !== "ok" || result.status !== 200) return false;
      return Reflect.get(result.value, "schema_version") === 1 && Reflect.get(result.value, "authority") === "ready";
    },
    async proxy(request: AdapterProxy): Promise<AdapterResult> {
      if (upstreamInflight >= PHONE_GATEWAY_LIMITS.concurrentUpstream) return { kind: "unavailable" };
      if (!await ensure() || csrf === undefined) return { kind: "unavailable" };
      const headers: Record<string, string> = {
        Accept: "application/json",
        "X-JARVIS-CSRF": csrf,
        "X-Request-Id": randomUUID(),
        Host: `${LOOPBACK}:${port}`,
      };
      if (request.method === "POST") {
        headers["Content-Type"] = "application/json; charset=utf-8";
        headers["Content-Length"] = String(request.body?.byteLength ?? 0);
        headers.Origin = `http://${LOOPBACK}:${port}`;
      }
      upstreamInflight += 1;
      try {
        const result = await upstreamJson({
          upstream, method: request.method, path: `${request.path}${request.query}`,
          headers, body: request.body, cap: request.responseCap, timeoutMs: PHONE_GATEWAY_LIMITS.totalTimeoutMs,
        });
        if (result.kind === "too_large") return { kind: "too_large" };
        if (result.kind !== "ok") return { kind: "unavailable" };
        if (result.status === 403) { csrf = undefined; return { kind: "unavailable" }; }
        if (![200, 400, 403, 404, 409, 413, 503].includes(result.status)) return { kind: "invalid" };
        if (Reflect.get(result.value, "schema_version") !== 1) return { kind: "invalid" };
        return { kind: "ok", status: result.status, body: result.value };
      } finally {
        upstreamInflight -= 1;
      }
    },
  };
}

export function writePhoneGatewayError(
  response: ServerResponse,
  input: { readonly status?: number; readonly code: PhoneErrorCode; readonly requestId: string },
): void {
  const status = input.status ?? ERROR_STATUS[input.code];
  writeJson(response, status, input.requestId, {
    schema_version: 1,
    error: { code: input.code, message: "Phone gateway request rejected", request_id: input.requestId },
  }, true);
}

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
}): PhoneGatewayServer {
  if (options.host !== LOOPBACK) throw new PhoneGatewayError(PHONE_ERROR_CODES.PHONE_NOT_READY);
  if (options.port !== 0 && options.port !== 4174) throw new PhoneGatewayError(PHONE_ERROR_CODES.PHONE_NOT_READY);
  const upstreamUrl = parseUpstream(options.upstream);
  if (upstreamUrl === undefined) throw new PhoneGatewayError(PHONE_ERROR_CODES.PHONE_NOT_READY);
  const staticRoot = realpathSync(options.staticRoot);
  const assets = loadAssetNames(staticRoot);
  const now = options.now ?? Date.now;
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

type AdapterProxy = {
  readonly method: "GET" | "POST";
  readonly path: string;
  readonly query: string;
  readonly body?: Buffer;
  readonly responseCap: number;
};
type AdapterResult =
  | { readonly kind: "ok"; readonly status: number; readonly body: unknown }
  | { readonly kind: "unavailable" }
  | { readonly kind: "invalid" }
  | { readonly kind: "too_large" };
type PhoneAuthorityReadAdapter = {
  ready(): Promise<boolean>;
  probeHealth(): Promise<boolean>;
  proxy(request: AdapterProxy): Promise<AdapterResult>;
};
type Bucket = { tokens: number; updatedAt: number };

type RequestCtx = {
  readonly request: IncomingMessage;
  readonly response: ServerResponse;
  readonly config: PhoneGatewayConfig;
  readonly sessions: PhoneGatewaySessionStore;
  readonly limiter: ReturnType<typeof createPhoneRateLimiter>;
  readonly adapter: PhoneAuthorityReadAdapter;
  readonly staticRoot: string;
  readonly assets: ReadonlySet<string>;
  readonly now: () => number;
  readonly audit: (line: string) => void;
  readonly upstream: string;
};

async function handleRequest(ctx: RequestCtx): Promise<void> {
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
    if (!withinHeaderBudget(ctx.request)) {
      code = PHONE_ERROR_CODES.PHONE_HEADERS_TOO_LARGE; status = 413;
      writePhoneGatewayError(ctx.response, { code, requestId }); finish(); return;
    }
    const method = ctx.request.method ?? "";
    const rawUrl = ctx.request.url ?? "/";
    const path = normalizePath(rawUrl);
    if (path === undefined) {
      code = PHONE_ERROR_CODES.PHONE_REQUEST_INVALID;
      writePhoneGatewayError(ctx.response, { code, requestId }); finish(); return;
    }
    if ((method === "GET" || method === "HEAD") && hasForbiddenGetBody(ctx.request)) {
      code = PHONE_ERROR_CODES.PHONE_BODY_FORBIDDEN;
      writePhoneGatewayError(ctx.response, { code, requestId }); finish(); return;
    }
    if ((path === "/healthz" || path === "/readyz") && (method === "GET" || method === "HEAD")) {
      if (path === "/healthz") {
        routeClass = "health"; outcome = "allowed"; code = "ok"; status = 200;
        writeJson(ctx.response, 200, requestId, { schema_version: 1, status: "ok" }, false); finish(); return;
      }
      const ready = await ctx.adapter.ready() && await ctx.adapter.probeHealth();
      routeClass = "readiness";
      if (!ready) {
        code = PHONE_ERROR_CODES.PHONE_NOT_READY; status = 503; outcome = "upstream_unavailable";
        writePhoneGatewayError(ctx.response, { code, requestId }); finish(); return;
      }
      outcome = "allowed"; code = "ok"; status = 200;
      writeJson(ctx.response, 200, requestId, { schema_version: 1, status: "ok" }, false); finish(); return;
    }
    const trusted = isTrustedServeRequest(ctx.request, ctx.config.publicHost);
    if (!trusted.ok) {
      code = trusted.code; status = ERROR_STATUS[code];
      writePhoneGatewayError(ctx.response, { code, requestId }); finish(); return;
    }
    const principal = authenticateTailnetOwner(trusted.login, ctx.config.ownerLogin);
    if (!principal.ok) {
      code = principal.code; status = ERROR_STATUS[code];
      writePhoneGatewayError(ctx.response, { code, requestId }); finish(); return;
    }
    ownerHex = ctx.config.ownerDigest.toString("hex").slice(0, 16);
    const origin = readOrigin(ctx.request.rawHeaders);
    const unsafe = method !== "GET" && method !== "HEAD";
    if (origin.kind === "bad" || (origin.kind === "ok" && origin.value !== ctx.config.publicOrigin)
      || (unsafe && origin.kind !== "ok")) {
      code = PHONE_ERROR_CODES.PHONE_ORIGIN_FORBIDDEN; status = 403;
      writePhoneGatewayError(ctx.response, { code, requestId }); finish(); return;
    }
    const cookieHeaders = headerValues(ctx.request.rawHeaders, "cookie");
    if (cookieHeaders.length > 1) {
      code = PHONE_ERROR_CODES.PHONE_SESSION_REQUIRED; status = 401;
      expireAndError(ctx, requestId, code); finish(); return;
    }
    const auth = ctx.sessions.authenticate(cookieHeaders[0], ctx.config.ownerDigest);
    const matched = matchPhoneRoute({ method, path, rawUrl });
    if (matched.kind === "invalid") {
      code = PHONE_ERROR_CODES.PHONE_REQUEST_INVALID; status = 400;
      writePhoneGatewayError(ctx.response, { code, requestId }); finish(); return;
    }
    if (matched.kind === "method_forbidden") {
      code = PHONE_ERROR_CODES.PHONE_METHOD_FORBIDDEN; status = 403;
      writePhoneGatewayError(ctx.response, { code, requestId }); finish(); return;
    }
    if (matched.kind === "not_found") {
      code = PHONE_ERROR_CODES.PHONE_ROUTE_NOT_FOUND; status = 404;
      writePhoneGatewayError(ctx.response, { code, requestId }); finish(); return;
    }
    routeClass = matched.routeClass;
    if (auth.kind !== "ok") {
      const limited = ctx.limiter.takePreSession(ownerHex);
      if (!limited.ok) {
        code = PHONE_ERROR_CODES.PHONE_RATE_LIMITED; status = 429;
        retryAfter(ctx.response, limited.retryAfter);
        writePhoneGatewayError(ctx.response, { code, requestId }); finish(); return;
      }
    } else {
      const limited = ctx.limiter.takeSession(auth.idHmac.toString("hex"));
      if (!limited.ok) {
        code = PHONE_ERROR_CODES.PHONE_RATE_LIMITED; status = 429;
        retryAfter(ctx.response, limited.retryAfter);
        writePhoneGatewayError(ctx.response, { code, requestId }); finish(); return;
      }
    }
    if (matched.routeClass === "session") {
      const issued = ctx.sessions.issue(ctx.config.ownerDigest);
      if (issued.kind === "capacity") {
        code = PHONE_ERROR_CODES.PHONE_CAPACITY_EXCEEDED; status = 429;
        writePhoneGatewayError(ctx.response, { code, requestId }); finish(); return;
      }
      ctx.response.setHeader("Set-Cookie", issued.setCookie);
      outcome = "allowed"; code = "ok"; status = 200;
      writeJson(ctx.response, 200, requestId, {
        schema_version: 1, csrf_token: issued.csrfToken, expires_at: new Date(issued.expiresAt).toISOString(),
      }, true); finish(); return;
    }
    if (auth.kind !== "ok") {
      code = PHONE_ERROR_CODES.PHONE_SESSION_REQUIRED; status = 401;
      expireAndError(ctx, requestId, code); finish(); return;
    }
    if (matched.needsCsrf) {
      const csrfValues = headerValues(ctx.request.rawHeaders, CSRF_HEADER);
      if (csrfValues.length !== 1 || csrfValues[0] === undefined || !ctx.sessions.csrfMatches(auth.csrfHmac, csrfValues[0])) {
        code = PHONE_ERROR_CODES.PHONE_CSRF_REQUIRED; status = 403;
        writePhoneGatewayError(ctx.response, { code, requestId }); finish(); return;
      }
    }
    if (matched.routeClass === "shell") {
      const html = phoneHtml(path === "/memory" ? "Memory" : "Today");
      const refreshed = ctx.sessions.touch(auth.idHmac);
      if (refreshed !== undefined) ctx.response.setHeader("Set-Cookie", serializeCookie(cookieId(cookieHeaders[0]), refreshed.maxAge));
      outcome = "allowed"; code = "ok"; status = 200;
      writeHtml(ctx.response, requestId, html); finish(); return;
    }
    if (matched.routeClass === "asset") {
      const refreshed = ctx.sessions.touch(auth.idHmac);
      if (refreshed !== undefined) ctx.response.setHeader("Set-Cookie", serializeCookie(cookieId(cookieHeaders[0]), refreshed.maxAge));
      if (!writeAsset(ctx, path, requestId)) {
        code = PHONE_ERROR_CODES.PHONE_ROUTE_NOT_FOUND; status = 404;
        writePhoneGatewayError(ctx.response, { code, requestId }); finish(); return;
      }
      outcome = "allowed"; code = "ok"; status = 200; finish(); return;
    }
    let body: Buffer | undefined;
    if (method === "POST") {
      const parsed = await readPostBody(ctx.request);
      if (parsed.kind !== "ok") {
        code = parsed.code; status = parsed.status;
        writePhoneGatewayError(ctx.response, { status, code, requestId }); finish(); return;
      }
      if (!validateMemoryBody(path, parsed.buffer)) {
        code = PHONE_ERROR_CODES.PHONE_REQUEST_INVALID; status = 400;
        writePhoneGatewayError(ctx.response, { code, requestId }); finish(); return;
      }
      body = parsed.buffer;
    }
    const proxied = await ctx.adapter.proxy({
      method: method === "POST" ? "POST" : "GET", path: matched.path, query: matched.query,
      body, responseCap: matched.responseCap,
    });
    if (proxied.kind === "too_large") {
      code = PHONE_ERROR_CODES.PHONE_RESPONSE_TOO_LARGE; status = 413; outcome = "rejected";
      writePhoneGatewayError(ctx.response, { code, requestId }); finish(); return;
    }
    if (proxied.kind === "unavailable") {
      code = PHONE_ERROR_CODES.PHONE_UPSTREAM_UNAVAILABLE; status = 503; outcome = "upstream_unavailable";
      writePhoneGatewayError(ctx.response, { code, requestId }); finish(); return;
    }
    if (proxied.kind !== "ok") {
      code = PHONE_ERROR_CODES.PHONE_UPSTREAM_INVALID; status = 502; outcome = "upstream_unavailable";
      writePhoneGatewayError(ctx.response, { code, requestId }); finish(); return;
    }
    const refreshed = ctx.sessions.touch(auth.idHmac);
    if (refreshed !== undefined) ctx.response.setHeader("Set-Cookie", serializeCookie(cookieId(cookieHeaders[0]), refreshed.maxAge));
    outcome = "allowed"; code = "ok"; status = proxied.status;
    writeJson(ctx.response, proxied.status, requestId, proxied.body, true); finish();
  } catch (error) {
    if (error instanceof Error && ctx.response.headersSent) { ctx.response.destroy(); finish(); return; }
    if (ctx.response.headersSent) { ctx.response.destroy(); finish(); return; }
    code = PHONE_ERROR_CODES.PHONE_UPSTREAM_INVALID; status = 502;
    writePhoneGatewayError(ctx.response, { code, requestId }); finish();
  }
}

function route(
  routeClass: (typeof PHONE_CORE_ROUTES)[number]["routeClass"],
  method: "GET" | "HEAD" | "POST",
  path: string,
  query: string,
  responseCap: number,
  needsSession: boolean,
  needsCsrf: boolean,
  proxy: boolean,
): PhoneRouteMatch {
  return { kind: "ok", routeClass, method, path, query, responseCap, needsSession, needsCsrf, proxy };
}

function knownMethods(path: string): readonly string[] | undefined {
  const exact = new Map<string, readonly string[]>([
    ["/healthz", ["GET", "HEAD"]], ["/readyz", ["GET", "HEAD"]],
    ["/api/v1/phone/session", ["GET"]], ["/", ["GET"]], ["/memory", ["GET"]],
    ["/NOTICE-ARGO.txt", ["GET", "HEAD"]], ["/api/v1/today", ["GET"]],
    ["/api/v1/decision-inbox", ["GET"]], ["/api/v1/notification-intents", ["GET"]],
    ["/api/v1/source-health", ["GET"]], ["/api/v1/memory/conflicts", ["GET"]],
    ["/api/v1/memory/status", ["GET"]],
  ]);
  const hit = exact.get(path);
  if (hit !== undefined) return hit;
  if (path.startsWith("/assets/")) return ["GET", "HEAD"];
  if (path.startsWith("/api/v1/recommendations/") && !path.slice("/api/v1/recommendations/".length).includes("/")) {
    return ["GET"];
  }
  if (/^\/api\/v1\/contexts\/[^/]+\/evidence$/.test(path)) return ["GET"];
  return undefined;
}

function matchList(path: string, query: string): PhoneRouteMatch | undefined {
  if (path !== "/api/v1/decision-inbox" && path !== "/api/v1/notification-intents" && path !== "/api/v1/source-health") {
    return undefined;
  }
  const params = exactQuery(query, ["limit", "cursor"]);
  if (params === undefined) return { kind: "invalid" };
  const rawLimit = params.get("limit");
  if (rawLimit === null || rawLimit === undefined || canonicalInt(rawLimit, 1, 100) === undefined) return { kind: "invalid" };
  const cursor = params.get("cursor");
  if (cursor !== null && cursor !== undefined && (cursor.length === 0 || Buffer.byteLength(cursor) > 2048)) {
    return { kind: "invalid" };
  }
  return route("today", "GET", path, query, PHONE_GATEWAY_LIMITS.jsonResponse, true, true, true);
}

function matchEvidence(path: string, query: string): PhoneRouteMatch | undefined {
  const match = /^\/api\/v1\/contexts\/([^/]+)\/evidence$/.exec(path);
  if (match === null || match[1] === undefined || !isSafeId(match[1])) return undefined;
  const params = exactQuery(query, ["recommendation_id"]);
  const recommendationId = params?.get("recommendation_id");
  if (recommendationId === undefined || recommendationId === null || !isSafeId(recommendationId)) return { kind: "invalid" };
  return route("today", "GET", path, `?recommendation_id=${recommendationId}`, PHONE_GATEWAY_LIMITS.jsonResponse, true, true, true);
}

function matchId(path: string, prefix: string): string | undefined {
  if (!path.startsWith(prefix)) return undefined;
  const id = path.slice(prefix.length);
  return id.length > 0 && !id.includes("/") && isSafeId(id) ? id : undefined;
}

function assetName(path: string): string | undefined {
  if (!path.startsWith("/assets/")) return undefined;
  const name = path.slice("/assets/".length);
  if (name.length === 0 || name.includes("/") || name.endsWith(".map") || !/^[A-Za-z0-9._-]+$/.test(name)) return undefined;
  return name;
}

function queryPart(rawUrl: string): string | undefined {
  if (rawUrl.includes("%") || rawUrl.includes("#")) return undefined;
  const cut = rawUrl.indexOf("?");
  return cut === -1 ? "" : rawUrl.slice(cut);
}

function exactQuery(query: string, allowed: readonly string[]): URLSearchParams | undefined {
  if (query === "") {
    const empty = new URLSearchParams();
    return allowed.length === 0 ? empty : undefined;
  }
  if (!query.startsWith("?")) return undefined;
  try {
    const params = new URL(`http://127.0.0.1/${query}`).searchParams;
    const keys = [...new Set(params.keys())];
    for (const key of keys) {
      if (!allowed.includes(key) || params.getAll(key).length !== 1) return undefined;
    }
    return params;
  } catch (error) {
    if (error instanceof TypeError) return undefined;
    throw error;
  }
}

function canonicalInt(raw: string, min: number, max: number): number | undefined {
  if (!/^[1-9]\d{0,2}$/.test(raw)) return undefined;
  const value = Number(raw);
  return value >= min && value <= max ? value : undefined;
}

function isSafeId(value: string): boolean {
  if (value.length === 0 || Buffer.byteLength(value) > 256 || value !== value.normalize("NFC")) return false;
  if (value === "." || value === "..") return false;
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code < 32 || code === 127 || character === "/" || character === "?" || character === "#"
      || character === " " || character === "\t") return false;
  }
  return true;
}

function takeBucket(
  map: Map<string, Bucket>,
  id: string,
  capacity: number,
  refillPerMinute: number,
  now: () => number,
): { readonly ok: true } | { readonly ok: false; readonly retryAfter: number } {
  if (map.size >= PHONE_GATEWAY_LIMITS.limiterEntries && !map.has(id)) {
    const oldest = [...map.entries()].sort((left, right) => left[1].updatedAt - right[1].updatedAt)[0];
    if (oldest !== undefined) map.delete(oldest[0]);
  }
  const current = now();
  const bucket = map.get(id) ?? { tokens: capacity, updatedAt: current };
  const refill = (current - bucket.updatedAt) * (refillPerMinute / 60_000);
  bucket.tokens = Math.min(capacity, bucket.tokens + refill);
  bucket.updatedAt = current;
  if (bucket.tokens < 1) {
    map.set(id, bucket);
    const waitMs = (1 - bucket.tokens) / (refillPerMinute / 60_000);
    return { ok: false, retryAfter: Math.max(1, Math.ceil(waitMs / 1000)) };
  }
  bucket.tokens -= 1;
  map.set(id, bucket);
  return { ok: true };
}

function parseEnvRecords(text: string): Map<string, string> | undefined {
  if (text.includes("\r")) return undefined;
  const lines = text.endsWith("\n") ? text.slice(0, -1).split("\n") : text.split("\n");
  const records = new Map<string, string>();
  for (const line of lines) {
    const eq = line.indexOf("=");
    if (eq <= 0) return undefined;
    const key = line.slice(0, eq);
    const value = line.slice(eq + 1);
    if (!/^[A-Z][A-Z0-9_]*$/.test(key) || value.length === 0 || records.has(key)) return undefined;
    records.set(key, value);
  }
  return records;
}

function parseHttpsOrigin(value: string): { readonly origin: string; readonly host: string } | undefined {
  let url: URL;
  try { url = new URL(value); } catch (error) {
    if (error instanceof TypeError) return undefined;
    throw error;
  }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "" || url.port !== ""
    || url.search !== "" || url.hash !== "" || (url.pathname !== "/" && url.pathname !== "")) return undefined;
  const host = url.hostname;
  if (host.endsWith(".") || host.includes("*") || host.startsWith("[") || /^\d+\.\d+\.\d+\.\d+$/.test(host)) return undefined;
  if (value !== `https://${host}` && value !== `https://${host}/`) return undefined;
  return { origin: `https://${host}`, host };
}

function isWellFormedLogin(login: string): boolean {
  return login.length >= 1 && Buffer.byteLength(login) <= 254 && /^[\x21-\x2b\x2d-\x7e]+$/.test(login);
}

function readSecretFile(path: string, uid: number, bytes?: number): Buffer {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.uid !== uid || (stat.mode & 0o777) !== 0o600) {
    throw new PhoneGatewayError(PHONE_ERROR_CODES.PHONE_NOT_READY);
  }
  const body = readFileSync(path);
  if (bytes !== undefined && body.byteLength !== bytes) throw new PhoneGatewayError(PHONE_ERROR_CODES.PHONE_NOT_READY);
  return body;
}

function realpathChecked(path: string): string {
  try { return realpathSync(path); } catch (error) {
    if (error instanceof Error) throw new PhoneGatewayError(PHONE_ERROR_CODES.PHONE_NOT_READY);
    throw error;
  }
}

function inside(root: string, target: string): boolean {
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
  return target === root || target.startsWith(prefix);
}

function headerValues(rawHeaders: readonly string[], name: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < rawHeaders.length; index += 2) {
    if (rawHeaders[index]?.toLowerCase() === name) values.push(rawHeaders[index + 1] ?? "");
  }
  return values;
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

function parseUpstream(value: string): string | undefined {
  let url: URL;
  try { url = new URL(value); } catch (error) {
    if (error instanceof TypeError) return undefined;
    throw error;
  }
  if (url.protocol !== "http:" || url.hostname !== LOOPBACK || url.pathname !== "/" || url.search !== ""
    || url.hash !== "" || url.username !== "" || url.password !== "") return undefined;
  const port = url.port === "" ? 80 : Number(url.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return undefined;
  return `http://${LOOPBACK}:${String(port)}`;
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

function expireAndError(ctx: RequestCtx, requestId: string, code: PhoneErrorCode): void {
  ctx.response.setHeader("Set-Cookie", ctx.sessions.expireCookie());
  writePhoneGatewayError(ctx.response, { code, requestId });
}

function retryAfter(response: ServerResponse, seconds: number): void {
  response.setHeader("Retry-After", String(seconds));
}

function cookieId(header: string | undefined): string {
  if (header === undefined) return "";
  const match = /__Host-jarvis-phone=([^;]+)/.exec(header);
  return match?.[1] ?? "";
}

function phoneHtml(title: string): string {
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/><meta name="jarvis-phone-mode" content="1"/><title>JARVIS</title></head><body><a class="skip-link" href="#main-content">skip</a><header><nav aria-label="Phone"><a href="/">Today</a><a href="/memory">Memory</a></nav></header><main id="main-content"><h1>${title}</h1></main></body></html>`;
}

function writeJson(
  response: ServerResponse,
  status: number,
  requestId: string,
  body: unknown,
  extraSecurity: boolean,
): void {
  if (response.headersSent) return;
  const payload = JSON.stringify(body);
  response.statusCode = status;
  response.setHeader("X-Request-Id", requestId);
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Strict-Transport-Security", SECURITY["Strict-Transport-Security"]);
  if (extraSecurity) applySecurity(response);
  response.setHeader("Content-Length", Buffer.byteLength(payload));
  response.end(payload);
}

function writeHtml(response: ServerResponse, requestId: string, html: string): void {
  if (response.headersSent) return;
  response.statusCode = 200;
  response.setHeader("X-Request-Id", requestId);
  response.setHeader("Content-Type", "text/html; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Strict-Transport-Security", SECURITY["Strict-Transport-Security"]);
  applySecurity(response);
  response.setHeader("Content-Length", Buffer.byteLength(html));
  response.end(html);
}

function applySecurity(response: ServerResponse): void {
  response.setHeader("Content-Security-Policy", SECURITY["Content-Security-Policy"]);
  response.setHeader("Referrer-Policy", SECURITY["Referrer-Policy"]);
  response.setHeader("X-Content-Type-Options", SECURITY["X-Content-Type-Options"]);
  response.setHeader("X-Frame-Options", SECURITY["X-Frame-Options"]);
  response.setHeader("Permissions-Policy", SECURITY["Permissions-Policy"]);
}

function writeAsset(ctx: RequestCtx, path: string, requestId: string): boolean {
  try {
    if (path === "/NOTICE-ARGO.txt") {
      const resolved = realpathSync(join(ctx.staticRoot, "NOTICE-ARGO.txt"));
      if (dirname(resolved) !== ctx.staticRoot || !statSync(resolved).isFile()) return false;
      return sendFile(ctx.response, requestId, resolved, "text/plain; charset=utf-8");
    }
    const name = assetName(path);
    if (name === undefined || !ctx.assets.has(name)) return false;
    const assetsRoot = realpathSync(join(ctx.staticRoot, "assets"));
    if (!inside(ctx.staticRoot, assetsRoot)) return false;
    const resolved = realpathSync(join(assetsRoot, name));
    if (!inside(assetsRoot, resolved) || !statSync(resolved).isFile()) return false;
    const type = name.endsWith(".css") ? "text/css; charset=utf-8"
      : name.endsWith(".js") ? "text/javascript; charset=utf-8" : undefined;
    if (type === undefined) return false;
    return sendFile(ctx.response, requestId, resolved, type);
  } catch (error) {
    if (error instanceof Error) return false;
    throw error;
  }
}

function sendFile(response: ServerResponse, requestId: string, file: string, type: string): boolean {
  const body = readFileSync(file);
  if (body.byteLength > PHONE_GATEWAY_LIMITS.asset) return false;
  if (response.headersSent) return true;
  response.statusCode = 200;
  response.setHeader("X-Request-Id", requestId);
  response.setHeader("Content-Type", type);
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Strict-Transport-Security", SECURITY["Strict-Transport-Security"]);
  applySecurity(response);
  response.setHeader("Content-Length", body.byteLength);
  response.end(body);
  return true;
}

function loadAssetNames(root: string): ReadonlySet<string> {
  const names = new Set<string>();
  for (const candidate of [join(root, "manifest.json"), join(root, ".vite", "manifest.json")]) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(candidate, "utf8"));
      if (typeof parsed !== "object" || parsed === null) continue;
      for (const value of Object.values(parsed)) {
        if (typeof value !== "object" || value === null) continue;
        const file = Reflect.get(value, "file");
        if (typeof file === "string") names.add(basename(file));
        const css = Reflect.get(value, "css");
        if (!Array.isArray(css)) continue;
        for (const item of css) if (typeof item === "string") names.add(basename(item));
      }
    } catch (error) {
      if (error instanceof Error) continue;
      throw error;
    }
  }
  return names;
}

async function readPostBody(request: IncomingMessage): Promise<
  | { readonly kind: "ok"; readonly buffer: Buffer }
  | { readonly kind: "error"; readonly status: number; readonly code: PhoneErrorCode }
> {
  if (headerValues(request.rawHeaders, "transfer-encoding").length > 0) {
    return { kind: "error", status: 400, code: PHONE_ERROR_CODES.PHONE_REQUEST_INVALID };
  }
  const types = headerValues(request.rawHeaders, "content-type");
  if (types.length !== 1 || types[0]?.toLowerCase() !== "application/json; charset=utf-8") {
    return { kind: "error", status: 400, code: PHONE_ERROR_CODES.PHONE_REQUEST_INVALID };
  }
  const lengths = headerValues(request.rawHeaders, "content-length");
  if (lengths.length !== 1 || lengths[0] === undefined || !/^[1-9][0-9]*$/.test(lengths[0])) {
    return { kind: "error", status: 400, code: PHONE_ERROR_CODES.PHONE_REQUEST_INVALID };
  }
  const declared = Number(lengths[0]);
  if (declared > PHONE_GATEWAY_LIMITS.postBody) {
    request.resume();
    return { kind: "error", status: 413, code: PHONE_ERROR_CODES.PHONE_REQUEST_INVALID };
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const piece = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    size += piece.byteLength;
    if (size > PHONE_GATEWAY_LIMITS.postBody) {
      request.destroy();
      return { kind: "error", status: 413, code: PHONE_ERROR_CODES.PHONE_REQUEST_INVALID };
    }
    chunks.push(piece);
  }
  if (size !== declared) return { kind: "error", status: 400, code: PHONE_ERROR_CODES.PHONE_REQUEST_INVALID };
  return { kind: "ok", buffer: Buffer.concat(chunks, size) };
}

function validateMemoryBody(path: string, buffer: Buffer): boolean {
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(buffer); } catch (error) {
    if (error instanceof TypeError) return false;
    throw error;
  }
  if (text.charCodeAt(0) === 0xfeff) return false;
  for (const ch of text) {
    const code = ch.charCodeAt(0);
    if (code < 32 && code !== 9 && code !== 10 && code !== 13) return false;
  }
  const keys = topLevelKeys(text);
  if (keys === undefined || new Set(keys).size !== keys.length) return false;
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch (error) {
    if (error instanceof SyntaxError) return false;
    throw error;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return false;
  if (keys.some(key => key === "__proto__" || key === "constructor" || key === "prototype")) return false;
  if (Reflect.get(parsed, "schema_version") !== 1) return false;
  if (path === "/api/v1/memory/search") {
    if (keys.length !== 3 || !keys.includes("schema_version") || !keys.includes("query") || !keys.includes("limit")) return false;
    const query = Reflect.get(parsed, "query");
    const limit = Reflect.get(parsed, "limit");
    return typeof query === "string" && query === query.trim() && query === query.normalize("NFC")
      && Buffer.byteLength(query) >= 1 && Buffer.byteLength(query) <= 512
      && typeof limit === "number" && Number.isInteger(limit) && limit >= 1 && limit <= 20;
  }
  if (path === "/api/v1/memory/records/detail") {
    if (keys.length !== 2 || !keys.includes("schema_version") || !keys.includes("record_token")) return false;
    const token = Reflect.get(parsed, "record_token");
    return typeof token === "string" && /^[A-Za-z0-9_-]{43}$/.test(token);
  }
  return false;
}

function topLevelKeys(text: string): string[] | undefined {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{")) return undefined;
  const keys: string[] = [];
  let index = 1;
  const skip = (): void => {
    while (index < trimmed.length && (trimmed[index] === " " || trimmed[index] === "\n"
      || trimmed[index] === "\r" || trimmed[index] === "\t")) index += 1;
  };
  skip();
  if (trimmed[index] === "}") return keys;
  while (index < trimmed.length) {
    if (trimmed[index] !== "\"") return undefined;
    const read = readJsonString(trimmed, index);
    if (read === undefined) return undefined;
    keys.push(read.value);
    index = read.end;
    skip();
    if (trimmed[index] !== ":") return undefined;
    index += 1;
    skip();
    const end = skipJsonValue(trimmed, index);
    if (end === undefined) return undefined;
    index = end;
    skip();
    if (trimmed[index] === "}") return keys;
    if (trimmed[index] !== ",") return undefined;
    index += 1;
    skip();
  }
  return undefined;
}

function readJsonString(text: string, start: number): { readonly value: string; readonly end: number } | undefined {
  if (text[start] !== "\"") return undefined;
  let index = start + 1;
  let value = "";
  while (index < text.length) {
    const ch = text[index];
    if (ch === "\"") return { value, end: index + 1 };
    if (ch === "\\") {
      index += 2;
      continue;
    }
    value += ch;
    index += 1;
  }
  return undefined;
}

function skipJsonValue(text: string, start: number): number | undefined {
  let index = start;
  const skip = (): void => {
    while (index < text.length && (text[index] === " " || text[index] === "\n" || text[index] === "\r" || text[index] === "\t")) {
      index += 1;
    }
  };
  skip();
  const ch = text[index];
  if (ch === "\"") {
    const read = readJsonString(text, index);
    return read?.end;
  }
  if (ch === "{") {
    index += 1;
    skip();
    if (text[index] === "}") return index + 1;
    for (;;) {
      const key = readJsonString(text, index);
      if (key === undefined) return undefined;
      index = key.end; skip();
      if (text[index] !== ":") return undefined;
      index += 1;
      const end = skipJsonValue(text, index);
      if (end === undefined) return undefined;
      index = end; skip();
      if (text[index] === "}") return index + 1;
      if (text[index] !== ",") return undefined;
      index += 1; skip();
    }
  }
  if (ch === "[") {
    index += 1; skip();
    if (text[index] === "]") return index + 1;
    for (;;) {
      const end = skipJsonValue(text, index);
      if (end === undefined) return undefined;
      index = end; skip();
      if (text[index] === "]") return index + 1;
      if (text[index] !== ",") return undefined;
      index += 1; skip();
    }
  }
  if (ch === "t" || ch === "f" || ch === "n" || ch === "-" || (ch !== undefined && ch >= "0" && ch <= "9")) {
    while (index < text.length && /[0-9eE+tnfalsu.-]/.test(text[index] ?? "")) index += 1;
    return index;
  }
  return undefined;
}

async function upstreamJson(input: {
  readonly upstream: string;
  readonly method: string;
  readonly path: string;
  readonly headers: Record<string, string>;
  readonly body?: Buffer;
  readonly cap: number;
  readonly timeoutMs: number;
}): Promise<
  | { readonly kind: "ok"; readonly status: number; readonly value: Record<string, unknown> }
  | { readonly kind: "too_large" }
  | { readonly kind: "error" }
> {
  const url = new URL(input.upstream);
  return await new Promise(resolve => {
    const req = httpRequest({
      host: LOOPBACK,
      port: Number(url.port),
      path: input.path,
      method: input.method,
      headers: input.headers,
    }, response => {
      if (response.headers["transfer-encoding"] !== undefined) {
        response.destroy();
        resolve({ kind: "error" });
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      response.on("data", (chunk: Buffer | string) => {
        const piece = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
        size += piece.byteLength;
        if (size > input.cap) {
          response.destroy();
          resolve({ kind: "too_large" });
          return;
        }
        chunks.push(piece);
      });
      response.on("end", () => {
        try {
          const text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, size));
          const parsed: unknown = JSON.parse(text);
          if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
            resolve({ kind: "error" });
            return;
          }
          const record = recordFromUnknown(parsed);
          if (record === undefined) { resolve({ kind: "error" }); return; }
          resolve({ kind: "ok", status: response.statusCode ?? 0, value: record });
        } catch (error) {
          if (error instanceof Error) resolve({ kind: "error" });
          else resolve({ kind: "error" });
        }
      });
    });
    req.setTimeout(input.timeoutMs, () => { req.destroy(); resolve({ kind: "error" }); });
    req.on("socket", socket => {
      socket.setTimeout(PHONE_GATEWAY_LIMITS.connectTimeoutMs, () => { req.destroy(); });
    });
    req.on("error", () => resolve({ kind: "error" }));
    if (input.body !== undefined) req.end(input.body);
    else req.end();
  });
}

function closedCsrf(value: Record<string, unknown>): string | undefined {
  const keys = Object.keys(value);
  if (keys.length !== 2 || !keys.includes("schema_version") || !keys.includes("csrf_token")) return undefined;
  if (value.schema_version !== 1 || typeof value.csrf_token !== "string") return undefined;
  if (!/^[A-Za-z0-9_-]{32,128}$/.test(value.csrf_token)) return undefined;
  return value.csrf_token;
}

function recordFromUnknown(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record: Record<string, unknown> = {};
  for (const key of Object.keys(value)) record[key] = Reflect.get(value, key);
  return record;
}

function durationBucket(ms: number): "lt100ms" | "lt1s" | "lt10s" | "ge10s" {
  if (ms < 100) return "lt100ms";
  if (ms < 1000) return "lt1s";
  if (ms < 10_000) return "lt10s";
  return "ge10s";
}

