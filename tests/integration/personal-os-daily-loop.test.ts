import { describe, expect, it } from "vitest";
import { createEveningCloseout, DailyControlLoop, dailyPhaseSchedule, generateMorningBrief, NotificationIntentStore } from "../../src/index.js";
import { closePersonalDb, personalDb } from "./personal-operations-test-helpers.js";

describe("personal operating daily loop", () => {
  it("uses KST schedule, exactly-once identity, leases, and restart recovery", async () => {
    expect(dailyPhaseSchedule("2026-08-29", "morning").scheduled_at).toBe("2026-08-28T22:15:00.000Z");
    const db = await personalDb();
    try {
      const loop = new DailyControlLoop(db.db, () => new Date("2026-08-29T00:00:00.000Z"));
      const first = loop.ensureRun("2026-08-29", "morning");
      expect(loop.ensureRun("2026-08-29", "morning").run_id).toBe(first.run_id);
      const claim = loop.claim(first.run_id, "worker:a", 10_000);
      expect(claim.lease_fence).toBe(1);
      const recovered = loop.recoverExpiredLeases(new Date("2026-08-29T00:01:00.000Z"));
      expect(recovered).toBe(1);
      const reclaimed = loop.claim(first.run_id, "worker:b", 10_000, new Date("2026-08-29T00:01:00.000Z"));
      expect(reclaimed.lease_fence).toBe(2);
      expect(loop.advance(first.run_id, "worker:b", 2, "running", undefined, undefined, new Date("2026-08-29T00:01:01.000Z")).state).toBe("running");
      expect(loop.advance(first.run_id, "worker:b", 2, "verifying", undefined, undefined, new Date("2026-08-29T00:01:02.000Z")).state).toBe("verifying");
      expect(loop.advance(first.run_id, "worker:b", 2, "completed", { ok: true }, undefined, new Date("2026-08-29T00:01:03.000Z")).state).toBe("completed");
      expect(() => loop.advance(first.run_id, "worker:a", 1, "failed", undefined, "stale")).toThrow("DAILY_LOOP_STALE_FENCE");
    } finally { closePersonalDb(db); }
  });

  it("rejects invalid dates, skipped transitions, expired leases, and uncoded failures", async () => {
    expect(() => dailyPhaseSchedule("2026-02-30", "in_day")).toThrow("DAILY_LOOP_DATE_INVALID");
    const db = await personalDb();
    try {
      const now = new Date("2026-08-29T00:00:00.000Z");
      const loop = new DailyControlLoop(db.db, () => now);
      expect(() => loop.ensureRun("2026-08-29", "in_day", "2026-08-29T00:00:00.000Z")).toThrow("DAILY_LOOP_EXPIRY_INVALID");
      const run = loop.ensureRun("2026-08-29", "in_day");
      const claim = loop.claim(run.run_id, "worker", 10_000);
      expect(() => loop.advance(run.run_id, "worker", claim.lease_fence, "verifying")).toThrow("DAILY_LOOP_TRANSITION_INVALID");
      expect(() => loop.advance(run.run_id, "worker", claim.lease_fence, "failed")).toThrow("DAILY_LOOP_FAILURE_REQUIRED");
      expect(() => loop.advance(run.run_id, "worker", claim.lease_fence, "running", undefined, undefined, new Date("2026-08-29T00:00:11.000Z"))).toThrow("DAILY_LOOP_STALE_FENCE");
    } finally { closePersonalDb(db); }
  });

  it("emits honest degraded brief and preserves verified closeout requirements", () => {
    const brief = generateMorningBrief({ loop_date: "2026-08-29", now: "2026-08-29T00:20:00.000Z", refresh: { state: "capped", completed_at: null, source_id: "second-brain" }, sources: [{ source_id: "orca", state: "fresh", detail: "ok", checked_at: "2026-08-29T00:19:00.000Z" }], actions: [{ action_id: "a1", title: "Inspect blocker", rank: 2, citation_ids: ["ev1"] }, { action_id: "a2", title: "Resolve deadline", rank: 1, citation_ids: ["ev2"] }, { action_id: "a3", title: "Third", rank: 3, citation_ids: ["ev3"] }, { action_id: "a4", title: "Not shown", rank: 4, citation_ids: ["ev4"] }], blocked: ["b1"], decisions: ["d1"], workers: ["w1"], risks: ["r1"] });
    expect(brief.state).toBe("degraded");
    expect(brief.sections.next_three.map(action => action.action_id)).toEqual(["a2", "a1", "a3"]);
    expect(brief.warnings).toContain("second_brain_refresh:capped");
    expect(() => createEveningCloseout({ loop_date: "2026-08-29", run_id: "run:1", completions: [{ item_id: "x", summary: "done", evidence_refs: [], verification_id: null }], open_items: [], decisions: [], candidate_ids: [], improvements: [], tomorrow_first_action: null, now: "2026-08-29T13:00:00.000Z" })).toThrow("CLOSEOUT_EVIDENCE_REQUIRED");
    expect(createEveningCloseout({ loop_date: "2026-08-29", run_id: "run:1", completions: [{ item_id: "x", summary: "done", evidence_refs: ["artifact:1"], verification_id: "verification:1" }], open_items: [{ item_id: "y", state: "blocked", reason: "owner decision" }], decisions: ["d1"], candidate_ids: ["candidate:1", "candidate:1"], improvements: [], tomorrow_first_action: "Review y", now: "2026-08-29T13:00:00.000Z" }).state).toBe("incomplete");
  });

  it("deduplicates redacted notification intents and expires them", async () => {
    const db = await personalDb();
    try {
      const store = new NotificationIntentStore(db.db);
      const input = { intent_id: "intent:1", correlation_id: "corr:1", idempotency_key: "idem:1", dedup_key: "dedup:1", urgency: "action" as const, channel: "mac" as const, title: "Decision required", summary: "Review blocker", resource_id: "resource:decision:1", expires_at: "2026-08-29T01:00:00.000Z", now: "2026-08-29T00:00:00.000Z" };
      expect(store.enqueue(input).state).toBe("created");
      expect(store.enqueue(input).intent_id).toBe("intent:1");
      expect(store.expire("2026-08-29T02:00:00.000Z")).toBe(1);
      expect(store.list("expired")).toHaveLength(1);
      expect(() => store.enqueue({ ...input, intent_id: "intent:2", idempotency_key: "idem:2", title: "token=secret" })).toThrow("NOTIFICATION_REDACTION_REQUIRED");
    } finally { closePersonalDb(db); }
  });
});
