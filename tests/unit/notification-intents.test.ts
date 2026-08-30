import { describe, expect, it } from "vitest";
import { deriveNotificationDecision, NotificationIntentError, parseDecisionQueueInput,
  projectOwnerDecisionQueue } from "../../src/notification-intents.js";
import { decisionInput, decisionRecord, NOTICE_NOW } from "../fixtures/notification-intent-fixture.js";

const reason = (input: unknown): string => projectOwnerDecisionQueue(parseDecisionQueueInput(decisionInput([input])))
  .omissions[0]?.reason ?? "included";

describe("Task 22 owner decision queue boundary", () => {
  it("orders owner decisions by the Task 17 tuple and collapses semantic duplicates with covered provenance", () => {
    // Given: two active owner decisions and one semantic duplicate with independent citation.
    const later = decisionRecord({ semantic_key: "internal:review", action_id: "review-internal", title: "Review internal change",
      deadline: null, priority: { owner_safety_gate: "owner_approval_required", customer_impact: "internal", deadline_bucket: "none",
        dependency_blocking: "non_blocking", irreversible_risk: "low", effort_cost: "low", stable_identity: "review-internal" } });
    const duplicate = decisionRecord({ recommendation_id: "rec:pos:v1:decision-duplicate", context_id: "ctx:pos:v1:context-duplicate",
      source_ids: ["src:linux:calendar"], citations: [{ source_id: "src:linux:calendar", evidence_ref: "calendar:deploy",
        evidence_digest: `sha256:${"c".repeat(64)}`, observed_at: "2026-08-28T11:30:00.000Z", fresh_until: "2026-08-28T13:30:00.000Z" }] });
    // When: input order is reversed.
    const output = projectOwnerDecisionQueue(parseDecisionQueueInput(decisionInput([later, duplicate, decisionRecord()])));
    // Then: priority is deterministic and duplicate provenance remains covered.
    expect(output.active.map(item => item.semantic_key)).toEqual(["deploy:customer-api", "internal:review"]);
    expect(output.active[0]?.contributing_recommendation_ids).toEqual([
      "rec:pos:v1:decision-1", "rec:pos:v1:decision-duplicate",
    ]);
    expect(output.active[0]).toMatchObject({ urgency: "critical", category: "owner_decision" });
    expect(output.active[0]?.citations).toHaveLength(2);
    expect(output.active[0]?.contributing_context_ids).toHaveLength(2);
  });

  it("derives inactive states and exact omission reasons", () => {
    expect(reason(decisionRecord({ events: [{ state: "snoozed", occurred_at: NOTICE_NOW,
      event_digest: `sha256:${"a".repeat(64)}` }] }))).toBe("snoozed");
    expect(reason(decisionRecord({ events: [{ state: "accepted", occurred_at: NOTICE_NOW,
      event_digest: `sha256:${"b".repeat(64)}` }] }))).toBe("resolved");
    expect(reason(decisionRecord({ expires_at: NOTICE_NOW }))).toBe("expired");
    for (const state of ["stale", "conflicted", "deleted", "superseded", "corrupt", "untrusted"] as const) {
      expect(reason(decisionRecord({ source_state: state }))).toBe(state);
    }
    expect(reason(decisionRecord({ citations: [] }))).toBe("uncited");
  });

  it("uses exact expiry, quiet-hour, and critical-deadline boundaries independent of locale", () => {
    const lasting = { expires_at: "2026-08-30T00:00:00.000Z", citations: [{ source_id: "src:linux:recommendations",
      evidence_ref: "live:deploy", evidence_digest: `sha256:${"e".repeat(64)}`, observed_at: "2026-08-28T11:00:00.000Z",
      fresh_until: "2026-08-30T00:00:00.000Z" }] };
    const urgencyAt = (clock: string, deadline: string | null): string => {
      const projected = projectOwnerDecisionQueue(parseDecisionQueueInput({ schema_version: 1, generated_at: clock,
        items: [decisionRecord({ ...lasting, deadline })] }));
      return deriveNotificationDecision(projected.active[0], clock, null).urgency;
    };
    expect(urgencyAt("2026-08-28T12:59:59.999Z", null)).toBe("digest");
    expect(urgencyAt("2026-08-28T13:00:00.000Z", null)).toBe("digest");
    expect(urgencyAt("2026-08-28T21:59:59.999Z", null)).toBe("digest");
    expect(urgencyAt("2026-08-28T22:00:00.000Z", null)).toBe("digest");
    expect(urgencyAt(NOTICE_NOW, "2026-08-28T13:00:00.000Z")).toBe("critical");
    expect(urgencyAt(NOTICE_NOW, "2026-08-28T13:00:00.001Z")).toBe("action");
    for (const [clock, expected] of [["2026-08-28T13:29:59.999Z", "included"],
      ["2026-08-28T13:30:00.000Z", "expired"], ["2026-08-28T13:30:00.001Z", "expired"]] as const) {
      const output = projectOwnerDecisionQueue(parseDecisionQueueInput({ schema_version: 1, generated_at: clock,
        items: [decisionRecord()] }));
      expect(output.active.length === 1 ? "included" : output.omissions[0]?.reason).toBe(expected);
    }
  });

  it("rejects accessor, proxy, surrogate, private metadata, and digest mutation without property execution", () => {
    let reads = 0;
    const accessor = decisionRecord(); Object.defineProperty(accessor, "title", { enumerable: true, get() { reads += 1; return "bad"; } });
    const hostile = [accessor, new Proxy(decisionRecord(), {}), decisionRecord({ title: "bad\ud800" }),
      decisionRecord({ title: "Authorization: Bearer private" }), { ...decisionRecord(), record_digest: `sha256:${"f".repeat(64)}` }];
    for (const value of hostile) expect(() => parseDecisionQueueInput(decisionInput([value])))
      .toThrowError(expect.objectContaining({ code: "NOTIFICATION_INPUT_INVALID" }));
    expect(reads).toBe(0);
    expect(NotificationIntentError).toBeTypeOf("function");
  });
});
