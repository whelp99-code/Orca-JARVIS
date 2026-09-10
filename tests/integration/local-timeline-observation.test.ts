import { PersonalContextEvidenceResolver } from "../../src/personal-context-evidence.js";
import { assemblePersonalContext } from "../../src/context-assembler.js";
import { canonicalPersonalContractHash } from "../../src/personal-validation.js";
import { expect, it } from "vitest";
import { AuthorityDb } from "../../src/db.js";
import { LocalTimelineSnapshotStore } from "../../src/local-timeline-snapshot-store.js";
import { MemoryProjectionAuthority } from "../../src/memory-projection-authority.js";
import { prepareLocalTimelineObservation, readCurrentLocalTimelineObservation } from "../../src/local-timeline-observation.js";

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

it("revalidates persisted drafts after source replacement and observation quarantine", async () => {
  const db = new AuthorityDb(":memory:", "migrations");
  const clock = () => new Date("2026-09-10T01:00:00Z");
  try {
    await db.migrate();
    db.db.exec(`INSERT INTO gjc_intents(intent_id,continuation_id,kind,payload_json,payload_digest,idempotency_key,state,created_at)
      VALUES ('fixture','task:fixture','dispatch','{}','sha256:fixture','fixture','pending','2026-09-10T00:00:00.000Z')`);
    const store = new LocalTimelineSnapshotStore(db, clock); store.register("task:fixture");
    const persist = () => {
      const snapshot = store.refresh("task:fixture");
      const draft = prepareLocalTimelineObservation(db, "task:fixture", snapshot.collection_id, clock);
      db.persistObservation(draft, clock().toISOString()); return draft;
    };
    const first = persist(); const before = db.db.serialize();
    expect(readCurrentLocalTimelineObservation(db, first.id, clock)).toEqual(first);
    expect(db.db.serialize().equals(before)).toBe(true);
    const second = persist();
    expect(() => readCurrentLocalTimelineObservation(db, first.id, clock)).toThrow("LOCAL_OBSERVATION_SOURCE_UNAVAILABLE");
    new MemoryProjectionAuthority(db).quarantineUnresolved({ kind: "observation", id: second.id, component_id: second.id }, clock());
    expect(() => readCurrentLocalTimelineObservation(db, second.id, clock)).toThrow("LOCAL_OBSERVATION_SOURCE_UNAVAILABLE");
    const third = persist(); store.setHeld("task:fixture", true);
    expect(() => readCurrentLocalTimelineObservation(db, third.id, clock)).toThrow("LOCAL_OBSERVATION_SOURCE_UNAVAILABLE");
  } finally { db.close(); }
});

it("blocks stale local observation evidence at the context persistence boundary", async () => {
  const db = new AuthorityDb(":memory:", "migrations"); const at = "2026-09-10T01:00:00.000Z";
  const clock = () => new Date(at);
  try {
    await db.migrate();
    db.db.exec(`INSERT INTO gjc_intents(intent_id,continuation_id,kind,payload_json,payload_digest,idempotency_key,state,created_at)
      VALUES ('fixture','task:fixture','dispatch','{}','sha256:fixture','fixture','pending','2026-09-10T00:00:00.000Z')`);
    const store = new LocalTimelineSnapshotStore(db, clock); store.register("task:fixture");
    const snapshot = store.refresh("task:fixture");
    const draft = prepareLocalTimelineObservation(db, "task:fixture", snapshot.collection_id, clock);
    db.persistObservation(draft, at);
    const base = assemblePersonalContext({ purpose: "daily_prioritization", query: "local evidence", clock: at,
      expires_in_ms: 240000, budgets: { max_items: 16, max_excerpt_bytes: 128, max_total_bytes: 4096 },
      observations: [], memories: [], pending_authority_refs: [] });
    const context = { ...base, payload: { ...base.payload, included_observation_refs: [draft.id] },
      evidence: [{ ...draft.evidence[0]!, digest: canonicalPersonalContractHash(draft) }] };
    expect(db.persistContextSnapshot({ context, memory_evidence: [] }, at)).toMatchObject({ observation_count: 1 });
    store.setHeld("task:fixture", true);
    const before = db.db.serialize();
    expect(() => new PersonalContextEvidenceResolver(db.db, code => new Error(code))
      .resolve({ context, memory_evidence: [] }, at)).toThrow("PERSONAL_CONTEXT_SOURCE_UNAVAILABLE");
    expect(db.db.serialize().equals(before)).toBe(true);
  } finally { db.close(); }
});
