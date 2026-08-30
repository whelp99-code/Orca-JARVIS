import { afterEach, describe, expect, it, vi } from "vitest";
import { createPersonalClient } from "./personal-api.js";

const AT = "2026-08-28T12:10:00.000Z";
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; vi.restoreAllMocks(); });

function response(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
}

const today = {
  schema_version: 1,
  resource: "today",
  generated_at: AT,
  state: "ready",
  brief: { state: "ready", brief_id: "brief:1", generated_at: AT, item_count: 3 },
  active_decision_count: 1,
  notification_summary: { total: 1, states: [{ state: "pending", count: 1 }] },
  current_daily_run: null,
  last_daily_run: null,
  latest_verified_closeout: null,
  next_actions: [{ recommendation_id: "rec:1", rank: 1, title: "검증된 다음 작업을 안전하게 시작합니다", confidence_class: "high", expires_at: AT, deep_link: "/recommendations/rec%3A1" }],
  conflicts: [],
  omissions: [],
  freshness: { state: "fresh", checked_at: AT, fresh_until: AT },
  deep_links: { decisions: "/api/v1/decision-inbox", daily_runs: "/api/v1/daily-runs", notifications: "/api/v1/notification-intents", source_health: "/api/v1/source-health" },
} as const;

describe("Task31 personal client", () => {
  it("parses the closed Today resource and rejects unknown fields", async () => {
    // Given: one canonical response followed by a response with an unknown field.
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce(response(today))
      .mockResolvedValueOnce(response({ ...today, private_score: 0.99 }));
    const client = createPersonalClient(async () => ({ schema_version: 1, csrf_token: "a".repeat(32) }));

    // When/Then: canonical data is accepted and the widened response fails generically.
    await expect(client.today()).resolves.toEqual(today);
    await expect(client.today()).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });

  it("rejects a schema-valid response above the Linux byte ceiling", async () => {
    // Given: every field is individually valid but the aggregate body exceeds 64 KiB.
    const oversized = { ...today, notification_summary: { total: 100,
      states: Array.from({ length: 100 }, (_, index) => ({ state: `${String(index)}-${"a".repeat(4_000)}`, count: 1 })) } };
    globalThis.fetch = vi.fn().mockResolvedValue(response(oversized));
    const client = createPersonalClient(async () => ({ schema_version: 1, csrf_token: "a".repeat(32) }));

    // When/Then: aggregate size fails before the resource parser accepts it.
    await expect(client.today()).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });

  it("posts only schema_version when accepting an action", async () => {
    // Given: a successful redacted staging response.
    const fetchMock = vi.fn().mockResolvedValue(response({ schema_version: 1, recommendation_id: "rec:1", action_rank: 1,
      request_id: "request:1", action: "workflow.start", state: "pending" }));
    globalThis.fetch = fetchMock;
    const client = createPersonalClient(async () => ({ schema_version: 1, csrf_token: "a".repeat(32) }));

    // When: the client accepts a recommendation action.
    await client.accept("rec:1", 1);

    // Then: no authority bytes cross the browser boundary.
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(init?.body).toBe('{"schema_version":1}');
    expect(String(init?.body)).not.toMatch(/principal|session|goal|args|budget|deadline|digest/iu);
  });
});
