import type { ServerResponse } from "node:http";
import type { ReconcileHub } from "./events.js";
import { writeDashboardJson } from "./http.js";
import type { MemoryRuntime } from "./memory-runtime.js";
import { MemoryCandidateDecisionSchema, MemoryCorrectSchema, MemoryDetailSchema,
  MemoryExportSchema, MemoryForgetSchema, MemorySearchSchema } from "./memory-validation.js";

type Input = { readonly path: string; readonly body: unknown; readonly response: ServerResponse;
  readonly requestId: string; readonly runtime: MemoryRuntime; readonly hub: ReconcileHub };
export async function tryHandleMemoryMutation(input: Input): Promise<boolean> {
  if (!input.path.startsWith("/api/v1/memory/")) return false;
  if (input.path === "/api/v1/memory/search") {
    const parsed = MemorySearchSchema.safeParse(input.body); if (!parsed.success) return invalid(input);
    write(input, 200, await input.runtime.read.search(parsed.data.query, parsed.data.limit)); return true;
  }
  if (input.path === "/api/v1/memory/records/detail") {
    const parsed = MemoryDetailSchema.safeParse(input.body); if (!parsed.success) return invalid(input);
    const detail = await input.runtime.read.detail(parsed.data.record_token);
    write(input, detail === undefined ? 404 : 200, detail ?? error(input, "MEMORY_RESOURCE_NOT_FOUND")); return true;
  }
  const candidate = candidateRoute(input.path);
  if (candidate !== undefined) {
    const parsed = MemoryCandidateDecisionSchema.safeParse(input.body); if (!parsed.success) return invalid(input);
    write(input, 503, error(input, "MEMORY_EFFECT_SERVICE_UNAVAILABLE")); return true;
  }
  const operation = effectRoute(input.path);
  if (operation === undefined) return false;
  const parsed = operation === "correct" ? MemoryCorrectSchema.safeParse(input.body)
    : operation === "forget" ? MemoryForgetSchema.safeParse(input.body) : MemoryExportSchema.safeParse(input.body);
  if (!parsed.success || input.runtime.mutation === undefined) return unavailable(input);
  const staged = await input.runtime.mutation.stageEffect({ operation, intent_id: parsed.data.intent_id,
    token: parsed.data.record_token, record_revision: parsed.data.record_revision,
    payload: parsed.data.payload });
  if (staged === undefined) { write(input, 404, error(input, "MEMORY_SELECTION_STALE")); return true; }
  input.hub.publish(["approvals", "memory.effects.v1"]);
  write(input, 202, { schema_version: 1, state: "pending_approval", request_id: staged.request_id,
    action: staged.action, message: "Pending owner approval" }); return true;
}
function candidateRoute(path: string): string | undefined {
  const match = /^\/api\/v1\/memory\/candidates\/([^/]+)\/actions\/stage-decision$/u.exec(path);
  return match?.[1] === undefined ? undefined : decodeURIComponent(match[1]);
}
function effectRoute(path: string): "correct" | "forget" | "export" | undefined {
  const value = /^\/api\/v1\/memory\/records\/actions\/(correct|forget|export)$/u.exec(path)?.[1];
  return value === "correct" || value === "forget" || value === "export" ? value : undefined;
}
function unavailable(input: Input): true { write(input, 503, error(input, "MEMORY_EFFECT_SERVICE_UNAVAILABLE")); return true; }
function invalid(input: Input): true { write(input, 400, error(input, "MEMORY_INPUT_INVALID")); return true; }
function error(input: Input, code: string) { return { schema_version: 1, error: { code,
  message: "Memory request failed", request_id: input.requestId } }; }
function write(input: Input, status: number, body: unknown): void {
  writeDashboardJson(input.response, { status, body, requestId: input.requestId });
}
