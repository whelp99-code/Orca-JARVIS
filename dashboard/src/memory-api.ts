import type { SessionResponse } from "./api.js";
import { readBoundedJson, ResponseBodyTooLargeError } from "./bounded-response.js";
import { MemoryCandidatesSchema, MemoryConflictsSchema, MemoryEffectsSchema,
  MemoryCandidateReviewSchema, MemoryCommandSchema, MemoryRememberProgressSchema,
  MemorySearchSchema, MemoryStatusSchema } from "./memory-types.js";

type SessionLoader = () => Promise<SessionResponse>;
export type MemoryClient = ReturnType<typeof createMemoryClient>;
export function createMemoryClient(loadSession: SessionLoader) {
  async function request(path: string, init: RequestInit = {}): Promise<unknown> {
    const session = await loadSession();
    const response = await fetch(path, { ...init, credentials: "same-origin", signal: init.signal,
      headers: { Accept: "application/json", "X-JARVIS-CSRF": session.csrf_token, ...init.headers } });
    let value: unknown;
    try { value = await readBoundedJson(response, 65_536); }
    catch (error: unknown) {
      if (error instanceof ResponseBodyTooLargeError) throw new Error("MEMORY_RESPONSE_TOO_LARGE");
      throw error;
    }
    if (!response.ok) throw new Error("MEMORY_REQUEST_FAILED");
    return value;
  }
  async function post(path: string, body: unknown, signal?: AbortSignal): Promise<unknown> {
    return request(path, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body), signal });
  }
  return {
    status: async () => MemoryStatusSchema.parse(await request("/api/v1/memory/status")),
    conflicts: async (signal?: AbortSignal) => MemoryConflictsSchema.parse(await request(
      "/api/v1/memory/conflicts?state=unresolved&limit=20", { signal })),
    candidates: async () => {
      const pages = await Promise.all(["awaiting_confirmation", "approved"].map(async state =>
        MemoryCandidatesSchema.parse(await request(`/api/v1/memory/candidates?state=${state}&limit=20`))));
      const first = pages[0]; if (first === undefined) throw new Error("MEMORY_REQUEST_FAILED");
      const items = pages.flatMap(page => page.items);
      return { ...first, items, page: { limit: 40, returned: items.length,
        has_more: pages.some(page => page.page.has_more), next_cursor: null } };
    },
    candidate: async (id: string, signal?: AbortSignal) => MemoryCandidateReviewSchema.parse(await request(
      `/api/v1/memory/candidates/${encodeURIComponent(id)}`, { signal })),
    candidateDecision: async (id: string, review_digest: string, decision: "confirm" | "reject") =>
      MemoryCommandSchema.parse(await post(`/api/v1/memory/candidates/${encodeURIComponent(id)}/actions/stage-decision`,
        { schema_version: 2, intent_id: intentId(), operation: "remember", decision, review_digest })),
    candidateDispatch: async (id: string) => MemoryCommandSchema.parse(await post(
      `/api/v1/memory/candidates/${encodeURIComponent(id)}/actions/stage-dispatch`,
      { schema_version: 1, intent_id: intentId() })),
    rememberProgress: async () => MemoryRememberProgressSchema.parse(await request(
      "/api/v1/memory/remember-progress?limit=20")),
    effects: async () => {
      const states = ["pending_approval", "applying", "completed", "available"] as const;
      const pages = await Promise.all(states.map(async state => MemoryEffectsSchema.parse(
        await request(`/api/v1/memory/effects?operation=export&state=${state}&limit=20`))));
      const items = pages.flatMap(page => page.items).slice(0, 100);
      const first = pages[0];
      if (first === undefined) throw new Error("MEMORY_REQUEST_FAILED");
      return { ...first, items, page: { limit: 20, returned: items.length, has_more: false,
        next_cursor: null } };
    },
    search: async (query: string, signal?: AbortSignal) => MemorySearchSchema.parse(await post(
      "/api/v1/memory/search", { schema_version: 1, query, limit: 20 }, signal)),
    correct: (record_token: string, record_revision: string, replacement: string) => post(
      "/api/v1/memory/records/actions/correct", { schema_version: 1, intent_id: intentId(),
        record_token, record_revision, payload: { replacement } }),
    forget: (record_token: string, record_revision: string) => post(
      "/api/v1/memory/records/actions/forget", { schema_version: 1, intent_id: intentId(),
        record_token, record_revision, payload: { acknowledge_irreversible: true,
          erasure_claim: "managed_erasure" } }),
    exportRecord: (record_token: string, record_revision: string) => post(
      "/api/v1/memory/records/actions/export", { schema_version: 1, intent_id: intentId(),
        record_token, record_revision, payload: { format: "json" } }),
  };
}
function intentId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return `memui:intent:v1:${[...bytes].map(value => value.toString(16).padStart(2, "0")).join("")}`;
}
