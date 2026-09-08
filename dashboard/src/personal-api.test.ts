import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createPersonalClient, parseDecision, parseEvidence, parseNotification, parseRecommendation, parseToday,
} from "./personal-api.js";

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
  notification_summary: { total: 1, states: [{ state: "ready", count: 1 }] },
  current_daily_run: null,
  last_daily_run: null,
  latest_verified_closeout: null,
  next_actions: [{ recommendation_id: "rec:1", rank: 1, title: "검증된 다음 작업을 안전하게 시작합니다", confidence_class: "high", expires_at: AT, deep_link: "/recommendations/rec%3A1" }],
  conflicts: [],
  omissions: [],
  freshness: { state: "fresh", checked_at: AT, fresh_until: AT },
  deep_links: { decisions: "/api/v1/decision-inbox", daily_runs: "/api/v1/daily-runs", notifications: "/api/v1/notification-intents", source_health: "/api/v1/source-health" },
} as const;

const DIGEST = `sha256:${"a".repeat(64)}`;
const decision = { recommendation_id: "rec:1", context_id: "ctx:1", rank: 1, title: "Review", state: "pending",
  confidence_class: "high", occurred_at: AT, expires_at: AT, evidence_digest: DIGEST, identity_digest: DIGEST,
  provenance_digest: DIGEST, citations: [{ context_evidence_id: "evi:1", digest: DIGEST, kind: "current", ref: "live:1" }],
  deep_link: "/recommendations/rec%3A1" };
const notification = { intent_id: "intent:1", correlation_id: "corr:1", urgency: "normal", channel: "in_app",
  preview: "Ready", deep_link: "/today", state: "ready", expires_at: AT, created_at: AT, updated_at: AT };
const recommendation = { schema_version: 1, resource: "recommendation", recommendation_id: "rec:1", context_id: "ctx:1",
  canonical_digest: DIGEST, evidence_digest: DIGEST, approval_requirement: "owner", confidence_class: "high",
  lifecycle_state: "eligible", expires_at: AT, state: "ready", actions: [{ rank: 1, title: "Review", operation: "review",
    target_digest: DIGEST, state: "pending", owner_decision_required: true, current: true, occurred_at: AT,
    transition_digest: null }], evidence: [], conflicts: [], omissions: [], deep_links: { context_evidence: "/api/v1/contexts/ctx:1/evidence" } };
const evidence = { schema_version: 1, resource: "context-evidence", context_id: "ctx:1", recommendation_id: "rec:1",
  state: "ready", freshness: { state: "fresh", fresh_until: AT }, evidence: [{ evidence_id: "evi:1", source_id: "src:1",
    kind: "linux_live_fact", digest: DIGEST, observed_at: AT, fresh_until: AT }], conflicts: [], omissions: [] };

describe("Task31 personal client", () => {
  it("accepts stale briefs and expired source freshness", () => {
    expect(parseToday({ ...today, state: "stale", brief: { ...today.brief, state: "stale", item_count: 0 },
      freshness: { ...today.freshness, state: "expired" } })).toMatchObject({
      state: "stale", brief: { state: "stale", item_count: 0 }, freshness: { state: "expired" },
    });
  });
  it("accepts explicit no-data timestamps while rejecting a missing freshness field", () => {
    const empty = { ...today, state: "no_data", next_actions: [],
      freshness: { state: "no_data", checked_at: null, fresh_until: null } };
    expect(parseToday(empty).freshness).toEqual(empty.freshness);
    expect(() => parseToday({ ...empty, freshness: { state: "no_data", fresh_until: null } }))
      .toThrowError(expect.objectContaining({ code: "VALIDATION_ERROR" }));
  });

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

  it.each([
    { name: "today state", parse: parseToday, value: { ...today, state: "unknown" } },
    { name: "today freshness", parse: parseToday, value: { ...today, freshness: { ...today.freshness, state: "unknown" } } },
    { name: "decision state", parse: parseDecision, value: { ...decision, state: "resolved" } },
    { name: "decision confidence", parse: parseDecision, value: { ...decision, confidence_class: "unknown" } },
    { name: "notification urgency", parse: parseNotification, value: { ...notification, urgency: "unknown" } },
    { name: "notification channel", parse: parseNotification, value: { ...notification, channel: "unknown" } },
    { name: "notification state", parse: parseNotification, value: { ...notification, state: "unknown" } },
    { name: "recommendation lifecycle", parse: parseRecommendation, value: { ...recommendation, lifecycle_state: "unknown" } },
    { name: "recommendation approval", parse: parseRecommendation, value: { ...recommendation, approval_requirement: "unknown" } },
    { name: "recommendation operation", parse: parseRecommendation, value: { ...recommendation,
      actions: [{ ...recommendation.actions[0], operation: "unknown" }] } },
    { name: "citation kind", parse: parseDecision, value: { ...decision,
      citations: [{ ...decision.citations[0], kind: "unknown" }] } },
    { name: "evidence kind", parse: parseEvidence, value: { ...evidence,
      evidence: [{ ...evidence.evidence[0], kind: "unknown" }] } },
  ])("rejects unknown $name vocabulary", ({ parse, value }) => {
    expect(() => parse(value)).toThrowError(expect.objectContaining({ code: "VALIDATION_ERROR" }));
  });

  it("rejects missing values, exotic prototypes, and nested accessors without invoking getters", () => {
    // Given: a missing discriminant, an exotic object, and an accessor nested inside an array.
    const missing: Record<string, unknown> = { ...today };
    delete missing["state"];
    const exotic = Object.assign(Object.create(null), today);
    let accesses = 0;
    const citation = { ...decision.citations[0] };
    Object.defineProperty(citation, "kind", { enumerable: true, get: () => { accesses += 1; return "current"; } });

    // When/Then: all fail generically and the getter remains untouched.
    expect(() => parseToday(missing)).toThrowError(expect.objectContaining({ code: "VALIDATION_ERROR" }));
    expect(() => parseToday(exotic)).toThrowError(expect.objectContaining({ code: "VALIDATION_ERROR" }));
    expect(() => parseDecision({ ...decision, citations: [citation] }))
      .toThrowError(expect.objectContaining({ code: "VALIDATION_ERROR" }));
    expect(accesses).toBe(0);
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
