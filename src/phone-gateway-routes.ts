import {
  PHONE_CORE_ROUTES,
  PHONE_GATEWAY_LIMITS,
  type PhoneRouteMatch,
} from "./phone-gateway-protocol.js";

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
    if (input.path === "/api/v1/phone/session" && query === "") {
      return route("session", method, input.path, "", 1024, false, false, false);
    }
    if ((input.path === "/" || input.path === "/memory") && query === "") {
      return route("shell", method, input.path, "", PHONE_GATEWAY_LIMITS.html, true, false, false);
    }
    if (input.path === "/NOTICE-ARGO.txt" && query === "") {
      return route("asset", method, input.path, "", PHONE_GATEWAY_LIMITS.asset, true, false, false);
    }
    const asset = assetName(input.path);
    if (asset !== undefined && query === "") {
      return route("asset", method, input.path, "", PHONE_GATEWAY_LIMITS.asset, true, false, false);
    }
    if (input.path === "/api/v1/today" && query === "") {
      return route("today", method, input.path, "", PHONE_GATEWAY_LIMITS.jsonResponse, true, true, true);
    }
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
    if (input.path === "/api/v1/memory/context") {
      return route("memory_context", method, input.path, "", PHONE_GATEWAY_LIMITS.jsonResponse, true, true, false);
    }
    if (input.path === "/api/v1/memory/search") {
      return route("memory_search", method, input.path, "", PHONE_GATEWAY_LIMITS.jsonResponse, true, true, true);
    }
    if (input.path === "/api/v1/memory/records/detail") {
      return route("memory_detail", method, input.path, "", PHONE_GATEWAY_LIMITS.memoryDetailResponse, true, true, true);
    }
  }
  return { kind: "not_found" };
}

export function assetName(path: string): string | undefined {
  if (!path.startsWith("/assets/")) return undefined;
  const name = path.slice("/assets/".length);
  if (name.length === 0 || name.includes("/") || name.endsWith(".map") || !/^[A-Za-z0-9._-]+$/.test(name)) {
    return undefined;
  }
  return name;
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
  if (rawLimit === null || rawLimit === undefined || canonicalInt(rawLimit, 1, 100) === undefined) {
    return { kind: "invalid" };
  }
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
  if (recommendationId === undefined || recommendationId === null || !isSafeId(recommendationId)) {
    return { kind: "invalid" };
  }
  return route("today", "GET", path, `?recommendation_id=${recommendationId}`, PHONE_GATEWAY_LIMITS.jsonResponse, true, true, true);
}

function matchId(path: string, prefix: string): string | undefined {
  if (!path.startsWith(prefix)) return undefined;
  const id = path.slice(prefix.length);
  return id.length > 0 && !id.includes("/") && isSafeId(id) ? id : undefined;
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
