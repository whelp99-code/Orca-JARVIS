import { afterEach, describe, expect, it, vi } from "vitest";
import { createMemoryClient, MemoryRequestError } from "./memory-api.js";

afterEach(() => { vi.unstubAllGlobals(); });
const session = async () => ({ schema_version: 1 as const, csrf_token: "csrf-fixture", session_id: "s" });
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
const effectPage = (operation: string, state: string, hasMore = false) => ({ schema_version: 1,
  resource: "memory-effects", generated_at: "2026-09-08T00:00:00.000Z", state: "ready",
  items: [{ request_id: `req:${operation}:${state}`, operation, state, failure_code: null,
    updated_at: "2026-09-08T00:00:00.000Z", proof_state: "pending", export_lifecycle: null }],
  page: { limit: 20, returned: 1, has_more: hasMore, next_cursor: null } });

describe("createMemoryClient", () => {
  it("reads correction and forgetting lifecycles, not only exports, and reports truncation", async () => {
    // Given effect pages for every operation
    const urls: string[] = [];
    vi.stubGlobal("fetch", async (input: string | URL | Request) => {
      const url = new URL(String(input), "http://127.0.0.1"); urls.push(url.search);
      const operation = url.searchParams.get("operation") ?? ""; const state = url.searchParams.get("state") ?? "";
      return json(effectPage(operation, state, operation === "forget" && state === "pending_approval"));
    });
    // When the client lists effects
    const effects = await createMemoryClient(session).effects();
    // Then forget and correct lifecycles are present and truncation is honest
    const operations = new Set(effects.items.map(item => item.operation));
    expect([...operations].sort()).toEqual(["correct", "export", "forget"]);
    expect(urls.some(url => url.includes("operation=forget&state=pending_approval"))).toBe(true);
    expect(urls.some(url => url.includes("operation=correct&state=applying"))).toBe(true);
    expect(effects.page.has_more).toBe(true);
  });

  it("surfaces the machine error code of a rejected command without its message", async () => {
    // Given a stale-selection rejection
    vi.stubGlobal("fetch", async () => json({ schema_version: 1, error: { code: "MEMORY_SELECTION_STALE",
      message: "raw provider prose that must never render", request_id: "r" } }, 404));
    // When a forget is staged
    const attempt = createMemoryClient(session).forget("token", "revision");
    // Then the typed error carries the code and status only
    await expect(attempt).rejects.toMatchObject({ code: "MEMORY_SELECTION_STALE", status: 404 });
    await expect(attempt).rejects.toBeInstanceOf(MemoryRequestError);
    await expect(attempt).rejects.not.toHaveProperty("message", expect.stringContaining("prose"));
  });
});
