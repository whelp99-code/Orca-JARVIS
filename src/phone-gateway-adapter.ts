import { randomUUID } from "node:crypto";
import { request as httpRequest } from "node:http";
import {
  LOOPBACK,
  PHONE_GATEWAY_LIMITS,
  type AdapterProxy,
  type AdapterResult,
  type PhoneAuthorityReadAdapter,
} from "./phone-gateway-protocol.js";

type Bucket = { tokens: number; updatedAt: number };

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
      if (!request.isAuthenticated()) return { kind: "unauthenticated" };
      // Other callers may have occupied the available slots while bootstrap ran.
      if (upstreamInflight >= PHONE_GATEWAY_LIMITS.concurrentUpstream) return { kind: "unavailable" };
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
      // setTimeout(ms, cb) leaves the callback installed, so a 1s connect budget must not
      // remain as the idle timeout for a slow authority health body.
      socket.on("timeout", () => { req.destroy(); });
      if (socket.connecting) {
        socket.setTimeout(PHONE_GATEWAY_LIMITS.connectTimeoutMs);
        socket.once("connect", () => {
          queueMicrotask(() => { socket.setTimeout(input.timeoutMs); });
        });
        return;
      }
      socket.setTimeout(input.timeoutMs);
    });
    req.on("error", () => resolve({ kind: "error" }));
    if (input.body !== undefined) req.end(input.body);
    else req.end();
  });
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
