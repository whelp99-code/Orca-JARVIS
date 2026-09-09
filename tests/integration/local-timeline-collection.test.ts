import { expect, it } from "vitest";
import { AuthorityDb } from "../../src/db.js";
import { LocalTimelineCollection } from "../../src/local-timeline-collection.js";

const at = "2026-09-09T01:00:00.000Z";
async function fixture() {
  const db = new AuthorityDb(":memory:", "migrations"); await db.migrate();
  db.db.exec(`INSERT INTO gjc_intents(intent_id,continuation_id,kind,payload_json,payload_digest,idempotency_key,state,created_at)
    VALUES ('a','task:collected','dispatch','{}','sha256:a','a','pending','2026-09-09T00:00:00.000Z')`);
  return db;
}
it("reads an unchanged local task twice with distinct collection identities and no database writes", async () => {
  const db = await fixture();
  try {
    const before = db.db.serialize(); const collector = new LocalTimelineCollection(db, () => new Date(at));
    const first = collector.collect("task:collected"), second = collector.collect("task:collected");
    expect(first).toMatchObject({ source_kind: "local_task_timeline", state: "completed", completed_at: at,
      source_updated_at: "2026-09-09T00:00:00.000Z" });
    expect(first.collection_id).not.toBe(second.collection_id);
    expect(first.content_digest).toBe(second.content_digest);
    expect(JSON.parse(first.context_json).task.task_id).toBe("task:collected");
    expect(Object.isFrozen(first)).toBe(true);
    expect(db.db.serialize().equals(before)).toBe(true);
  } finally { db.close(); }
});
it("rejects missing tasks, invalid IDs, future source time, clock rollback and nested transactions", async () => {
  const db = await fixture();
  try {
    const before = db.db.serialize();
    const collector = new LocalTimelineCollection(db, () => new Date(at));
    expect(() => collector.collect("task:missing")).toThrow("TASK_TIMELINE_NOT_FOUND");
    expect(() => collector.collect("bad id")).toThrow("LOCAL_COLLECTION_TASK_INVALID");
    expect(() => db.db.transaction(() => collector.collect("task:collected"))()).toThrow("LOCAL_COLLECTION_TRANSACTION_ACTIVE");
    expect(() => new LocalTimelineCollection(db, () => new Date("2026-09-08T00:00:00.000Z"))
      .collect("task:collected")).toThrow("LOCAL_COLLECTION_SOURCE_TIME_INVALID");
    const times = [at, "2026-09-09T00:59:59.000Z"];
    expect(() => new LocalTimelineCollection(db, () => new Date(times.shift()!))
      .collect("task:collected")).toThrow("LOCAL_COLLECTION_CLOCK_INVALID");
    expect(db.db.serialize().equals(before)).toBe(true);
  } finally { db.close(); }
});
it("reports capped when the task exceeds the event limit", async () => {
  const db = await fixture();
  try {
    const insert = db.db.prepare(`INSERT INTO gjc_intent_events(intent_id,event_type,payload_json,created_at)
      VALUES ('a','fixture.event','{}',?)`);
    db.db.transaction(() => { for (let i = 0; i < 1001; i++) insert.run(new Date(Date.parse(at) - 2000 + i).toISOString()); })();
    const result = new LocalTimelineCollection(db, () => new Date(at)).collect("task:collected");
    expect(result.state).toBe("capped"); expect(JSON.parse(result.context_json).truncated).toBe(true);
  } finally { db.close(); }
});
