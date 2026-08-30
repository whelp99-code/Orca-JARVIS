import { describe, expect, it } from "vitest";
import { AuthorityDb, DecisionNotificationService, NotificationIntentStore, deriveNotificationDecision,
  parseDecisionQueueInput, projectOwnerDecisionQueue, type DecisionQueueEventSource } from "../../src/index.js";
import { tempDb } from "../helpers.js";
import { decisionInput, decisionRecord, NOTICE_NOW } from "../fixtures/notification-intent-fixture.js";

class PushSource implements DecisionQueueEventSource {
  private listener: ((value: unknown) => void) | undefined;
  subscribe(listener: (value: unknown) => void): () => void { this.listener = listener; return () => { this.listener = undefined; }; }
  publish(value: unknown): void { this.listener?.(value); }
}
const queue = (record = decisionRecord(), now = NOTICE_NOW) => projectOwnerDecisionQueue(parseDecisionQueueInput({
  schema_version: 1, generated_at: now, items: [record],
}));
const counts = (db: AuthorityDb) => ({
  intents: Number((db.db.prepare("SELECT COUNT(*) AS n FROM notification_intents").get() as { n: number }).n),
  deliveries: Number((db.db.prepare("SELECT COUNT(*) AS n FROM notification_deliveries").get() as { n: number }).n),
  changes: Number((db.db.prepare("SELECT total_changes() AS n").get() as { n: number }).n),
});

describe("Task 22 notification intent policy and store", () => {
  it("derives allowed and quiet critical urgency while deferring noncritical exactly to 07:00 KST", () => {
    const allowed = queue(decisionRecord({ safety: "critical" }));
    expect(deriveNotificationDecision(allowed.active[0], NOTICE_NOW, null)).toMatchObject({ urgency: "critical", state: "queued",
      reason: "critical_owner_safety" });
    const quietAt = "2026-08-28T14:00:00.000Z";
    const quiet = { created_at: "2026-08-28T13:00:00.000Z", expires_at: "2026-08-29T00:00:00.000Z",
      citations: [{ source_id: "src:linux:recommendations", evidence_ref: "live:deploy", evidence_digest: `sha256:${"d".repeat(64)}`,
        observed_at: "2026-08-28T13:00:00.000Z", fresh_until: "2026-08-29T00:00:00.000Z" }] };
    expect(deriveNotificationDecision(queue(decisionRecord({ ...quiet, safety: "critical" }), quietAt).active[0], quietAt, null))
      .toMatchObject({ urgency: "critical", state: "queued", reason: "critical_quiet_hours_bypass" });
    expect(deriveNotificationDecision(queue(decisionRecord({ ...quiet, deadline: null }), quietAt).active[0], quietAt, null))
      .toMatchObject({ urgency: "digest", state: "deferred", not_before: "2026-08-28T22:00:00.000Z" });
  });

  it("applies debounce at -1/equality/+1 ms from persisted thread state", async () => {
    for (const [at, expected] of [["2026-08-28T12:14:59.999Z", "silent"], ["2026-08-28T12:15:00.000Z", "digest"],
      ["2026-08-28T12:15:00.001Z", "digest"]] as const) {
      const db = new AuthorityDb(tempDb()); await db.migrate();
      try {
        const store = new NotificationIntentStore(db); const entry = queue(decisionRecord({ deadline: null })).active[0];
        expect(entry).toBeDefined(); if (entry === undefined) return;
        store.persist(entry, "2026-08-28T12:00:00.000Z");
        expect(store.persist(queue(decisionRecord({ semantic_key: `deploy:${at}`, deadline: null })).active[0], at).urgency).toBe(expected);
      } finally { db.close(); }
    }
  });

  it("is restart/reorder idempotent, conflicts changed bytes atomically, and never writes deliveries", async () => {
    const path = tempDb(); const first = new AuthorityDb(path); await first.migrate();
    try {
      const entry = queue().active[0]; expect(entry).toBeDefined(); if (entry === undefined) return;
      const before = counts(first); const result = new NotificationIntentStore(first).persist(entry, NOTICE_NOW);
      expect(result).toMatchObject({ urgency: "critical", state: "queued" });
      const after = counts(first); expect(after.intents - before.intents).toBe(1); expect(after.deliveries - before.deliveries).toBe(0);
    } finally { first.close(); }
    const second = new AuthorityDb(path);
    try {
      const store = new NotificationIntentStore(second); const entry = queue().active[0];
      expect(store.persist(entry, NOTICE_NOW).urgency).toBe("silent");
      const before = counts(second);
      const changed = entry === undefined ? undefined : { ...entry, preview: "Changed protected decision" };
      expect(() => store.persist(changed, NOTICE_NOW)).toThrowError(expect.objectContaining({ code: "NOTIFICATION_IDENTITY_CONFLICT" }));
      const after = counts(second); expect(after.changes - before.changes).toBe(0); expect(after.deliveries).toBe(0);
    } finally { second.close(); }
  });

  it("subscribes before a push trigger and suppresses unchanged and resolved state exactly", async () => {
    const db = new AuthorityDb(tempDb()); await db.migrate(); const source = new PushSource();
    try {
      const service = new DecisionNotificationService(new NotificationIntentStore(db), source, () => new Date(NOTICE_NOW));
      const stop = service.start(); source.publish(decisionInput([decisionRecord()])); source.publish(decisionInput([decisionRecord()]));
      source.publish(decisionInput([decisionRecord(), decisionRecord({ source_state: "stale" })]));
      expect(counts(db)).toMatchObject({ intents: 1, deliveries: 0 });
      expect(db.db.prepare("SELECT state FROM notification_intents").get()).toEqual({ state: "queued" });
      source.publish(decisionInput([decisionRecord({ events: [{ state: "accepted", occurred_at: NOTICE_NOW,
        event_digest: `sha256:${"b".repeat(64)}` }] })]));
      expect(db.db.prepare("SELECT state FROM notification_intents").get()).toEqual({ state: "suppressed" });
      source.publish(decisionInput([decisionRecord()]));
      expect(db.db.prepare("SELECT state FROM notification_intents").get()).toEqual({ state: "suppressed" }); stop();
    } finally { db.close(); }
  });
});
