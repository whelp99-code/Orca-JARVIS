import { expect, it } from "vitest";
import { AuthorityDb } from "../../src/db.js";
import { LocalTimelineSnapshotStore } from "../../src/local-timeline-snapshot-store.js";
import { prepareLocalTimelineObservation } from "../../src/local-timeline-observation.js";

it("prepares only a current local advisory draft and rejects replacement, hold and expiry without writes", async () => {
  const db = new AuthorityDb(":memory:", "migrations");
  let time = new Date("2026-09-10T01:00:00Z"); const clock = () => time;
  try {
    await db.migrate();
    db.db.exec(`INSERT INTO gjc_intents(intent_id,continuation_id,kind,payload_json,payload_digest,idempotency_key,state,created_at)
      VALUES ('fixture','task:fixture','dispatch','{}','sha256:fixture','fixture','pending','2026-09-10T00:00:00.000Z')`);
    const store = new LocalTimelineSnapshotStore(db, clock); store.register("task:fixture");
    const first = store.refresh("task:fixture");
    const before = db.db.serialize();
    const draft = prepareLocalTimelineObservation(db, "task:fixture", first.collection_id, clock);
    expect(prepareLocalTimelineObservation(db, "task:fixture", first.collection_id, clock)).toEqual(draft);
    expect(draft.source.source_kind).toBe("timeline"); expect(draft.authority.authority_kind).toBe("none");
    expect(draft.expires_at).toBe("2026-09-10T01:05:00.000Z");
    expect(draft.payload.kind).toBe("local_task_state");
    expect(draft.payload.value).not.toHaveProperty("title");
    expect(db.db.serialize().equals(before)).toBe(true);
    const second = store.refresh("task:fixture");
    expect(() => prepareLocalTimelineObservation(db, "task:fixture", first.collection_id, clock)).toThrow("LOCAL_OBSERVATION_SOURCE_UNAVAILABLE");
    expect(prepareLocalTimelineObservation(db, "task:fixture", second.collection_id, clock).id).not.toBe(draft.id);
    time = new Date("2026-09-10T01:05:00Z");
    expect(() => prepareLocalTimelineObservation(db, "task:fixture", second.collection_id, clock)).toThrow("LOCAL_OBSERVATION_SOURCE_UNAVAILABLE");
    time = new Date("2026-09-10T01:00:00Z"); store.setHeld("task:fixture", true);
    expect(() => prepareLocalTimelineObservation(db, "task:fixture", second.collection_id, clock)).toThrow("LOCAL_OBSERVATION_SOURCE_UNAVAILABLE");
  } finally { db.close(); }
});
