import type { IncomingMessage, ServerResponse } from "node:http";
import { writeDashboardJson } from "./http.js";
import type { MemoryRuntime } from "./memory-runtime.js";
import { sessionMatchesCsrf, type DashboardSessionStore } from "./session.js";

type Input = { readonly path: string; readonly url: string | undefined; readonly request: IncomingMessage;
  readonly response: ServerResponse; readonly requestId: string; readonly session: DashboardSessionStore;
  readonly runtime: MemoryRuntime };
export async function tryHandleMemoryRead(input: Input): Promise<boolean> {
  if (!input.path.startsWith("/api/v1/memory/")) return false;
  if (!sessionMatchesCsrf(input.session, input.request.headers["x-jarvis-csrf"])) {
    write(input, 403, { schema_version: 1, error: { code: "LOCAL_SESSION_REQUIRED",
      message: "Local session required", request_id: input.requestId } }); return true;
  }
  if (input.path === "/api/v1/memory/status") { write(input, 200, input.runtime.read.status()); return true; }
  if (input.path === "/api/v1/memory/conflicts") {
    const limit = query(input.url, "limit", 20, 32); if (limit === undefined) return invalid(input);
    write(input, 200, await input.runtime.read.conflicts(limit)); return true;
  }
  if (input.path === "/api/v1/memory/candidates") {
    const limit = query(input.url, "limit", 20, 100); const state = textQuery(input.url, "state");
    if (limit === undefined || state === undefined) return invalid(input);
    write(input, 200, input.runtime.read.candidates(state, limit)); return true;
  }
  if (input.path === "/api/v1/memory/effects") {
    const limit = query(input.url, "limit", 20, 100); const operation = textQuery(input.url, "operation");
    const state = textQuery(input.url, "state");
    if (limit === undefined || state === undefined || operation === undefined
      || !["correct", "forget", "export"].includes(operation)) return invalid(input);
    write(input, 200, input.runtime.read.effects(operation, state, limit)); return true;
  }
  const candidate = segment(input.path, "/api/v1/memory/candidates/");
  if (candidate !== undefined) return resource(input, input.runtime.read.candidate(candidate));
  const effect = segment(input.path, "/api/v1/memory/effects/");
  if (effect !== undefined) return resource(input, input.runtime.read.effect(effect));
  return false;
}
function query(url: string | undefined, name: string, fallback: number, maximum: number) {
  const raw = new URL(url ?? "/", "http://127.0.0.1").searchParams.get(name);
  if (raw === null) return fallback;
  if (!/^[1-9]\d{0,2}$/.test(raw)) return undefined;
  const value = Number(raw); return value <= maximum ? value : undefined;
}
function textQuery(url: string | undefined, name: string) {
  const value = new URL(url ?? "/", "http://127.0.0.1").searchParams.get(name);
  return value === null || value.length === 0 || value.length > 64 ? undefined : value;
}
function segment(path: string, prefix: string) { const value = path.startsWith(prefix) ? path.slice(prefix.length) : "";
  return value && !value.includes("/") ? decodeURIComponent(value) : undefined; }
function invalid(input: Input): true { write(input, 400, { schema_version: 1, error: { code: "MEMORY_INPUT_INVALID",
  message: "Invalid memory input", request_id: input.requestId } }); return true; }
function resource(input: Input, value: unknown): true { write(input, value === undefined ? 404 : 200,
  value ?? { schema_version: 1, error: { code: "MEMORY_RESOURCE_NOT_FOUND",
    message: "Memory resource not found", request_id: input.requestId } }); return true; }
function write(input: Input, status: number, body: unknown): void {
  writeDashboardJson(input.response, { status, body, requestId: input.requestId });
}
