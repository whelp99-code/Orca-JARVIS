export const LOOPBACK = "127.0.0.1" as const;
export const PHONE_GATEWAY_PORT = 4176 as const;
export const PHONE_PUBLIC_HTTPS_PORT = 8444 as const;
export const PHONE_GATEWAY_TARGET = "http://127.0.0.1:4176" as const;
export const PHONE_SERVE_HTTPS_FLAG = "--https=8444" as const;
export const CSRF_HEADER = "x-jarvis-csrf";
export const FORBIDDEN_HEADERS = new Set([
  "forwarded", "x-forwarded-for", "x-forwarded-host", "x-forwarded-proto",
  "x-real-ip", "via", "proxy-authorization",
]);
export const SECURITY = {
  "Strict-Transport-Security": "max-age=31536000",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
  "Content-Security-Policy": [
    "default-src 'self'; base-uri 'none'; connect-src 'self'; form-action 'none';",
    " frame-ancestors 'none'; img-src 'self' data:; object-src 'none';",
    " script-src 'self'; style-src 'self'",
  ].join(""),
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
  PHONE_MEMORY_SCOPE_FORBIDDEN: "PHONE_MEMORY_SCOPE_FORBIDDEN",
  PHONE_MEMORY_CONTEXT_CHANGED: "PHONE_MEMORY_CONTEXT_CHANGED",
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

export const ERROR_STATUS: Record<PhoneErrorCode, number> = {
  PHONE_MEMORY_SCOPE_FORBIDDEN: 403,
  PHONE_MEMORY_CONTEXT_CHANGED: 409,
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
  { method: "GET", path: "/api/v1/memory/context/capabilities", routeClass: "memory_capabilities", proxyBranch: undefined },
  { method: "POST", path: "/api/v1/memory/context", routeClass: "memory_context", proxyBranch: undefined },
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
  readonly port: typeof PHONE_PUBLIC_HTTPS_PORT;
  readonly target: typeof PHONE_GATEWAY_TARGET;
  readonly funnel: false;
  readonly command_argv: readonly ["tailscale", "serve", "--bg", typeof PHONE_SERVE_HTTPS_FLAG, typeof PHONE_GATEWAY_TARGET];
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

export type ServeRequest = {
  readonly socket: { readonly remoteAddress?: string };
  readonly rawHeaders: readonly string[];
};

export type AdapterProxy = {
  /** Trusted request-local session check, invoked after asynchronous bootstrap. */
  readonly isAuthenticated: () => boolean;
  readonly method: "GET" | "POST";
  readonly path: string;
  readonly query: string;
  readonly body?: Buffer;
  readonly responseCap: number;
};

export type AdapterResult =
  | { readonly kind: "unauthenticated" }
  | { readonly kind: "ok"; readonly status: number; readonly body: unknown }
  | { readonly kind: "unavailable" }
  | { readonly kind: "invalid" }
  | { readonly kind: "too_large" };

export type PhoneAuthorityReadAdapter = {
  ready(): Promise<boolean>;
  probeHealth(): Promise<boolean>;
  proxy(request: AdapterProxy): Promise<AdapterResult>;
};
