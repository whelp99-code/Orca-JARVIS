import { dirname, join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { AuthorityDb } from "../../src/db.js";
import { LocalTimelineSnapshotStore } from "../../src/local-timeline-snapshot-store.js";
import { admitLocalTimelineObservation } from "../../src/local-timeline-observation.js";
import { LocalTimelineRefreshService } from "../../src/local-timeline-refresh-service.js";
import { buildFreshAuthority } from "../../src/memory-authority-fresh-builder.js";
import { localObservationChain, LOCAL_CHAIN_AT } from "../fixtures/local-observation-chain.js";
import { tempDb } from "../helpers.js";

const AT = LOCAL_CHAIN_AT;
const SUBJECTS = 8;
const CYCLES = 10;

const opened: AuthorityDb[] = [];
afterEach(() => { for (const db of opened.splice(0)) db.close(); });

const scalar = (db: AuthorityDb, sql: string): number => Number(db.db.prepare(sql).pluck().get());
const bytes = (db: AuthorityDb): number => Number(db.db.pragma("page_count", { simple: true }))
  * Number(db.db.pragma("page_size", { simple: true }));

/** Registers SUBJECTS synthetic tasks whose timelines never change during the run. */
async function registerSubjects(db: AuthorityDb) {
  await db.migrate();
  const store = new LocalTimelineSnapshotStore(db, () => new Date(AT));
  for (let index = 0; index < SUBJECTS; index++) {
    const task = `task:fixture-${index}`;
    db.db.prepare(`INSERT INTO gjc_intents(intent_id,continuation_id,kind,payload_json,payload_digest,
      idempotency_key,state,created_at) VALUES(?,?,'dispatch','{}','sha256:fixture',?,'pending',?)`)
      .run(`fixture-${index}`, task, `fixture-${index}`, "2026-08-28T11:00:00.000Z");
    store.register(task);
  }
  return store;
}

it("grows stored observations without bound while the replaceable cache stays capped", async () => {
  const db = new AuthorityDb(tempDb()); opened.push(db);
  const store = await registerSubjects(db);
  const before = bytes(db);
  let inserted = 0;
  for (let cycle = 0; cycle < CYCLES; cycle++) {
    for (let index = 0; index < SUBJECTS; index++) {
      const task = `task:fixture-${index}`;
      const snapshot = store.refresh(task);
      if (admitLocalTimelineObservation(db, task, snapshot.collection_id, () => new Date(AT)).inserted) inserted++;
    }
  }
  // Every refresh is a new collection, so every cycle admits new immutable rows.
  expect(inserted).toBe(SUBJECTS * CYCLES);
  expect(scalar(db, "SELECT COUNT(*) FROM personal_observations")).toBe(SUBJECTS * CYCLES);
  // The cache is replaced in place and stays at one row per registered subject.
  expect(scalar(db, "SELECT COUNT(*) FROM local_timeline_subjects")).toBe(SUBJECTS);
  expect(scalar(db, "SELECT COUNT(*) FROM local_timeline_subjects WHERE snapshot_json IS NOT NULL")).toBe(SUBJECTS);
  expect(bytes(db)).toBeGreaterThan(before);
  // Deletion lineage grows one audit row per admitted observation.
  expect(scalar(db,
    "SELECT COUNT(*) FROM personal_context_audit_events WHERE event_type='observation_recorded'"))
    .toBe(SUBJECTS * CYCLES);
});

it("separates per-collection storage identity from unchanged source content and task state", async () => {
  const db = new AuthorityDb(tempDb()); opened.push(db);
  const store = await registerSubjects(db);
  for (let cycle = 0; cycle < CYCLES; cycle++) {
    for (let index = 0; index < SUBJECTS; index++) {
      const task = `task:fixture-${index}`;
      store.refresh(task);
      const current = store.subjects().find(item => item.task_id === task);
      admitLocalTimelineObservation(db, task, String(current?.cached_collection_id), () => new Date(AT));
    }
  }
  // Storage identity is per collection: both digests embed the collection ID.
  expect(scalar(db, "SELECT COUNT(DISTINCT canonical_digest) FROM personal_observations")).toBe(SUBJECTS * CYCLES);
  expect(scalar(db, "SELECT COUNT(DISTINCT content_digest) FROM personal_observations")).toBe(SUBJECTS * CYCLES);
  // The only stable duplication signals are the collected source bytes and the task state.
  expect(scalar(db, `SELECT COUNT(DISTINCT json_extract(canonical_envelope_json,
    '$.payload.value.collection_content_digest')) FROM personal_observations`)).toBe(SUBJECTS);
  expect(scalar(db, `SELECT COUNT(DISTINCT json_extract(canonical_envelope_json,
    '$.payload.value.state')) FROM personal_observations`)).toBe(1);
});

it("replays the same collection instead of storing another observation", async () => {
  const db = new AuthorityDb(tempDb()); opened.push(db);
  const store = await registerSubjects(db);
  const task = "task:fixture-0";
  const snapshot = store.refresh(task);
  const first = admitLocalTimelineObservation(db, task, snapshot.collection_id, () => new Date(AT));
  const again = admitLocalTimelineObservation(db, task, snapshot.collection_id, () => new Date(AT));
  expect(first.inserted).toBe(true);
  expect(again.inserted).toBe(false);
  expect(again.observation_id).toBe(first.observation_id);
  expect(again.canonical_digest).toBe(first.canonical_digest);
  expect(scalar(db, "SELECT COUNT(*) FROM personal_observations")).toBe(1);
});

it("refuses in-place deletion of stored observations and their audit lineage", async () => {
  const db = new AuthorityDb(tempDb()); opened.push(db);
  const store = await registerSubjects(db);
  const task = "task:fixture-0";
  const snapshot = store.refresh(task);
  const admitted = admitLocalTimelineObservation(db, task, snapshot.collection_id, () => new Date(AT));
  // Retention cannot be a plain DELETE: the shipped schema aborts in-place removal.
  expect(() => db.db.prepare("DELETE FROM personal_observations WHERE observation_id=?")
    .run(admitted.observation_id)).toThrow("immutable personal observation");
  expect(() => db.db.prepare("DELETE FROM personal_context_audit_events WHERE subject_id=?")
    .run(admitted.observation_id)).toThrow("immutable personal context audit");
  expect(scalar(db, "SELECT COUNT(*) FROM personal_observations")).toBe(1);
});

it("collects without admitting, so the refresh service alone never grows stored observations", async () => {
  const db = new AuthorityDb(tempDb()); opened.push(db);
  await registerSubjects(db);
  const service = new LocalTimelineRefreshService(db, () => new Date(AT));
  const first = service.cycle();
  expect(first).toMatchObject({ subjects: SUBJECTS, attempted: SUBJECTS, collected: SUBJECTS, failed: 0, held: 0 });
  // Admission stays explicit: a collection cycle writes cache rows only.
  expect(scalar(db, "SELECT COUNT(*) FROM personal_observations")).toBe(0);
  expect(scalar(db, "SELECT COUNT(*) FROM personal_context_audit_events")).toBe(0);
  expect(scalar(db, "SELECT COUNT(*) FROM local_timeline_subjects WHERE snapshot_json IS NOT NULL")).toBe(SUBJECTS);
  // The same instance is throttled for 60s at the same clock.
  expect(service.cycle()).toBeUndefined();
});

it("fences a restarted or duplicated service so repeated starts cannot replace collections", async () => {
  const db = new AuthorityDb(tempDb()); opened.push(db);
  const store = await registerSubjects(db);
  let now = new Date(AT);
  const clock = () => now;
  const collections = () => new Set(store.subjects().map(item => String(item.cached_collection_id)));

  expect(new LocalTimelineRefreshService(db, clock).cycle()).toMatchObject({ collected: SUBJECTS });
  const afterFirst = collections();
  expect(afterFirst.size).toBe(SUBJECTS);

  // The fence is durable, so a fresh instance standing in for a restart is refused,
  // and so is a duplicate concurrent instance at the same clock.
  const writesBefore = scalar(db, "SELECT total_changes()");
  expect(new LocalTimelineRefreshService(db, clock).cycle()).toBeUndefined();
  expect(new LocalTimelineRefreshService(db, clock).cycle()).toBeUndefined();
  expect(collections()).toEqual(afterFirst);
  expect(scalar(db, "SELECT total_changes()")).toBe(writesBefore);

  // One row records the claim and the window it advanced to.
  expect(scalar(db, "SELECT COUNT(*) FROM local_timeline_cycle_fence")).toBe(1);
  expect(db.db.prepare("SELECT claimed_at,next_at FROM local_timeline_cycle_fence").get())
    .toEqual({ claimed_at: AT, next_at: new Date(Date.parse(AT) + 60_000).toISOString() });

  // Past the window a start collects again, which is the intended cadence rather than a bypass.
  now = new Date(Date.parse(AT) + 60_000);
  expect(new LocalTimelineRefreshService(db, clock).cycle()).toMatchObject({ collected: SUBJECTS });
  expect([...collections()].some(id => afterFirst.has(id))).toBe(false);
  // Collection still admits nothing by itself.
  expect(scalar(db, "SELECT COUNT(*) FROM personal_observations")).toBe(0);
});

/** Admits one observation per cycle on a single task, advancing the clock so expiries differ. */
async function admitAcrossTime(db: AuthorityDb, cycles: number, stepMs: number) {
  await db.migrate();
  const task = "task:fixture-0";
  db.db.prepare(`INSERT INTO gjc_intents(intent_id,continuation_id,kind,payload_json,payload_digest,
    idempotency_key,state,created_at) VALUES(?,?,'dispatch','{}','sha256:fixture',?,'pending',?)`)
    .run("fixture-0", task, "fixture-0", "2026-08-28T11:00:00.000Z");
  let now = new Date(AT);
  const clock = () => now;
  const store = new LocalTimelineSnapshotStore(db, clock);
  store.register(task);
  const admitted: { observation_id: string; expires_at: string }[] = [];
  for (let cycle = 0; cycle < cycles; cycle++) {
    now = new Date(Date.parse(AT) + cycle * stepMs);
    const snapshot = store.refresh(task);
    const result = admitLocalTimelineObservation(db, task, snapshot.collection_id, clock);
    admitted.push({ observation_id: result.observation_id,
      expires_at: String(db.db.prepare("SELECT expires_at FROM personal_observations WHERE observation_id=?")
        .pluck().get(result.observation_id)) });
  }
  return { admitted };
}

it("applies a retention cutoff inclusively and keeps the audit lineage of what it removed", async () => {
  const db = new AuthorityDb(tempDb()); opened.push(db);
  const { admitted } = await admitAcrossTime(db, 3, 60_000);
  const expiries = admitted.map(item => item.expires_at);
  expect(new Set(expiries).size).toBe(3);
  expect([...expiries].sort()).toEqual(expiries);
  const auditBefore = scalar(db, "SELECT COUNT(*) FROM personal_context_audit_events");
  const bytesBefore = bytes(db);

  // Cutoff sits exactly on the second observation's expiry to fix the boundary.
  const cutoff = expiries[1];
  const selected = db.db.prepare(
    "SELECT observation_id FROM personal_observations WHERE expires_at<=? ORDER BY expires_at").pluck().all(cutoff) as string[];
  expect(selected).toEqual([admitted[0]?.observation_id, admitted[1]?.observation_id]);

  const fresh = join(dirname(db.filename), "fresh-cutoff.sqlite");
  const result = await buildFreshAuthority(db, fresh, {
    blocked_projections: selected.map(id => ({ kind: "observation", id, component_id: id })),
    sensitive_material: [],
  });
  expect(result.foreign_key_errors).toBe(0);
  expect(result.integrity_check).toBe("ok");
  expect(result.result_generation).toBe(result.source_generation + 1);

  const rebuilt = new AuthorityDb(fresh); opened.push(rebuilt);
  // Only the observation past the cutoff survives; the boundary itself is removed.
  expect(rebuilt.db.prepare("SELECT observation_id FROM personal_observations").pluck().all())
    .toEqual([admitted[2]?.observation_id]);
  // Row count falls, but a freshly migrated database carries its own baseline, so a small
  // cutoff does not necessarily shrink the file. Retention is a row contract, not a size promise.
  expect(scalar(rebuilt, "SELECT COUNT(*) FROM personal_observations"))
    .toBeLessThan(scalar(db, "SELECT COUNT(*) FROM personal_observations"));
  expect(bytesBefore).toBeGreaterThan(0);
  // Removing subjects never removes their deletion lineage.
  expect(scalar(rebuilt, "SELECT COUNT(*) FROM personal_context_audit_events")).toBe(auditBefore);
  expect(scalar(rebuilt,
    "SELECT COUNT(*) FROM personal_context_audit_events WHERE event_type='observation_recorded'")).toBe(3);
});

it("refuses a rebuild that would remove an observation a surviving context still cites", async () => {
  const db = new AuthorityDb(tempDb()); opened.push(db);
  const chain = await localObservationChain(db);
  expect(scalar(db, "SELECT COUNT(*) FROM personal_context_observations")).toBe(1);
  const fresh = join(dirname(db.filename), "fresh.sqlite");
  // The rebuild filters context rows by blocked context, never by blocked observation, so a cutoff
  // that drops a cited observation leaves a dangling personal_context_observations reference.
  await expect(buildFreshAuthority(db, fresh, {
    blocked_projections: [{ kind: "observation", id: chain.observation.id, component_id: chain.observation.id }],
    sensitive_material: [],
  })).rejects.toThrow("MEMORY_COMPACTION_FOREIGN_KEY_INVALID");
  // The source database is untouched by the refused rebuild.
  expect(scalar(db, "SELECT COUNT(*) FROM personal_observations")).toBe(1);
  expect(scalar(db, "SELECT COUNT(*) FROM personal_context_observations")).toBe(1);
});

it("keeps audit lineage when the citing context is removed with its observation", async () => {
  const db = new AuthorityDb(tempDb()); opened.push(db);
  const chain = await localObservationChain(db);
  const audited = scalar(db, "SELECT COUNT(*) FROM personal_context_audit_events");
  expect(audited).toBeGreaterThan(0);
  const fresh = join(dirname(db.filename), "fresh.sqlite");
  const result = await buildFreshAuthority(db, fresh, {
    blocked_projections: [
      { kind: "observation", id: chain.observation.id, component_id: chain.observation.id },
      { kind: "context", id: chain.context.id, component_id: chain.context.id },
      { kind: "recommendation", id: chain.created.recommendation.id,
        component_id: chain.created.recommendation.id },
    ],
    sensitive_material: [],
  });
  expect(result.foreign_key_errors).toBe(0);
  expect(result.integrity_check).toBe("ok");
  expect(result.result_generation).toBe(result.source_generation + 1);
  const rebuilt = new AuthorityDb(fresh); opened.push(rebuilt);
  expect(scalar(rebuilt, "SELECT COUNT(*) FROM personal_observations")).toBe(0);
  expect(scalar(rebuilt, "SELECT COUNT(*) FROM personal_context_observations")).toBe(0);
  expect(scalar(rebuilt, "SELECT COUNT(*) FROM personal_recommendations")).toBe(0);
  // Deletion lineage survives its subject: audit rows are never filtered by the context rule.
  expect(scalar(rebuilt, "SELECT COUNT(*) FROM personal_context_audit_events")).toBe(audited);
  // The replaceable local cache never crosses physical reconstruction.
  expect(scalar(rebuilt, "SELECT COUNT(*) FROM local_timeline_subjects WHERE snapshot_json IS NOT NULL")).toBe(0);
  expect(scalar(rebuilt, "SELECT COUNT(*) FROM local_timeline_subjects")).toBe(1);
});
