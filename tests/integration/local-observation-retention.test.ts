import { dirname, join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { AuthorityDb } from "../../src/db.js";
import { LocalTimelineSnapshotStore } from "../../src/local-timeline-snapshot-store.js";
import { admitLocalTimelineObservation } from "../../src/local-timeline-observation.js";
import { buildFreshAuthority } from "../../src/memory-authority-fresh-builder.js";
import { selectLocalObservationRetention } from "../../src/local-observation-retention.js";
import { localObservationChain, LOCAL_CHAIN_AT, LOCAL_CHAIN_TASK_ID } from "../fixtures/local-observation-chain.js";
import { tempDb } from "../helpers.js";

const AT = LOCAL_CHAIN_AT;
const opened: AuthorityDb[] = [];
afterEach(() => { for (const db of opened.splice(0)) db.close(); });

const scalar = (db: AuthorityDb, sql: string): number => Number(db.db.prepare(sql).pluck().get());
const writes = (db: AuthorityDb) => db.db.prepare("SELECT total_changes() AS n").get();

/** Admits uncited observations on one task, advancing the clock so expiries differ. */
async function admitAcrossTime(db: AuthorityDb, cycles: number, stepMs: number) {
  await db.migrate();
  const task = "task:retention";
  db.db.prepare(`INSERT INTO gjc_intents(intent_id,continuation_id,kind,payload_json,payload_digest,
    idempotency_key,state,created_at) VALUES(?,?,'dispatch','{}','sha256:fixture',?,'pending',?)`)
    .run("retention", task, "retention", "2026-08-28T11:00:00.000Z");
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
  return admitted;
}

function addIntent(db: AuthorityDb, recommendation: string) {
  db.db.prepare(`INSERT INTO notification_intents(intent_id,correlation_id,idempotency_key,dedup_key,
    urgency,channel,redacted_preview,deep_link,state,expires_at,created_at,updated_at)
    VALUES(?,?,?,?,'action','mac','owner decision waiting',?,'created',?,?,?)`).run(
    "nin:pos:v1:fixture", "corr:pos:v1:018f0d4e-7b2a-7cc1-8a2b-3c4d5e6f7301", "idem:notify:fixture",
    "dedup:notify:fixture", `/recommendations/${encodeURIComponent(recommendation)}`,
    "2026-08-28T13:00:00.000Z", AT, AT);
}

it("selects expired uncited observations inclusively and never writes", async () => {
  const db = new AuthorityDb(tempDb()); opened.push(db);
  const admitted = await admitAcrossTime(db, 3, 60_000);
  const before = writes(db);
  const selection = selectLocalObservationRetention(db.db, admitted[1]?.expires_at);
  expect(selection.cutoff).toBe(admitted[1]?.expires_at);
  // Inclusive boundary: the observation sitting exactly on the cutoff is selected.
  expect(selection.blocked).toEqual([
    { kind: "observation", id: admitted[0]?.observation_id, component_id: admitted[0]?.observation_id },
    { kind: "observation", id: admitted[1]?.observation_id, component_id: admitted[1]?.observation_id },
  ]);
  expect(selection.retained).toEqual([]);
  expect(writes(db)).toEqual(before);
});

it("expands a cited observation to its context and recommendations", async () => {
  const db = new AuthorityDb(tempDb()); opened.push(db);
  const chain = await localObservationChain(db);
  const cutoff = String(db.db.prepare("SELECT expires_at FROM personal_observations WHERE observation_id=?")
    .pluck().get(chain.observation.id));
  const selection = selectLocalObservationRetention(db.db, cutoff);
  expect(selection.retained).toEqual([]);
  expect(selection.blocked.map(item => item.kind)).toEqual(["observation", "context", "recommendation"]);
  expect(selection.blocked.map(item => item.id)).toEqual([
    chain.observation.id, chain.context.id, chain.created.recommendation.id]);

  // The expansion is exactly what the rebuild adapter accepts.
  const fresh = join(dirname(db.filename), "fresh-retention.sqlite");
  const result = await buildFreshAuthority(db, fresh,
    { blocked_projections: selection.blocked, sensitive_material: [] });
  expect(result.foreign_key_errors).toBe(0);
  expect(result.integrity_check).toBe("ok");
  const rebuilt = new AuthorityDb(fresh); opened.push(rebuilt);
  expect(scalar(rebuilt, "SELECT COUNT(*) FROM personal_observations")).toBe(0);
  expect(scalar(rebuilt, "SELECT COUNT(*) FROM personal_recommendations")).toBe(0);
});

it("retains an observation whose recommendation a notification still addresses", async () => {
  const db = new AuthorityDb(tempDb()); opened.push(db);
  const chain = await localObservationChain(db);
  addIntent(db, chain.created.recommendation.id);
  const cutoff = String(db.db.prepare("SELECT expires_at FROM personal_observations WHERE observation_id=?")
    .pluck().get(chain.observation.id));
  const selection = selectLocalObservationRetention(db.db, cutoff);
  // Declining to delete is the conservative answer: no foreign key would have refused this.
  expect(selection.blocked).toEqual([]);
  expect(selection.retained).toEqual([
    { observation_id: chain.observation.id, reason: "notification_addresses_recommendation" }]);
});

it("retains an observation whose context also cites one still inside the window", async () => {
  const db = new AuthorityDb(tempDb()); opened.push(db);
  const chain = await localObservationChain(db);
  const cited = String(db.db.prepare("SELECT observation_id FROM personal_context_observations").pluck().get());
  expect(cited).toBe(chain.observation.id);
  // A second observation on the same context is simulated by cutting before the cited one,
  // so the context still references material outside the selection.
  const earlier = new Date(Date.parse(AT) - 60_000).toISOString();
  expect(selectLocalObservationRetention(db.db, earlier).blocked).toEqual([]);

  // Widening the cutoff past the cited observation selects the whole group instead.
  const cutoff = String(db.db.prepare("SELECT expires_at FROM personal_observations WHERE observation_id=?")
    .pluck().get(chain.observation.id));
  expect(selectLocalObservationRetention(db.db, cutoff).blocked).toHaveLength(3);
});

// Only the in-group case is reachable with a fixed-clock fixture: both chains share one expiry, so
// no cutoff can select one recommendation while leaving another that names it. The cross-group
// retention that `outside_event_names_replacement` exists for is therefore unmeasured, and needs
// the same time-parameterised chain fixture already recorded as a hold.
it("does not retain when the event naming a replacement is removed with its target", async () => {
  const db = new AuthorityDb(tempDb()); opened.push(db);
  const chain = await localObservationChain(db);
  const target = chain.created.recommendation.id;
  const cutoff = String(db.db.prepare("SELECT expires_at FROM personal_observations WHERE observation_id=?")
    .pluck().get(chain.observation.id));
  expect(selectLocalObservationRetention(db.db, cutoff).blocked).toHaveLength(3);

  // An event belonging to a recommendation outside this group names the group's recommendation as
  // its replacement. The rebuild filters events by their own recommendation, so removing the target
  // would leave that key dangling; the selection must decline instead.
  // The event table is immutable by trigger, which is the shipped guarantee; the trigger is
  // dropped here only to fabricate the naming row that a real supersession would have written.
  for (const name of db.db.prepare(
    "SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name='personal_recommendation_action_events'")
    .pluck().all() as string[]) db.db.exec(`DROP TRIGGER "${name.replaceAll('"', '""')}"`);
  db.db.prepare(`UPDATE personal_recommendation_action_events
    SET replacement_recommendation_id=? WHERE rowid=(SELECT MIN(rowid) FROM personal_recommendation_action_events)`)
    .run(target);
  const named = db.db.prepare(
    "SELECT recommendation_id FROM personal_recommendation_action_events WHERE replacement_recommendation_id=?")
    .pluck().get(target);
  expect(named).toBe(target);
  // Same group, so this must NOT retain: the naming event is removed together with its target.
  expect(selectLocalObservationRetention(db.db, cutoff).blocked).toHaveLength(3);
  expect(selectLocalObservationRetention(db.db, cutoff).retained).toEqual([]);
});

it("rejects a cutoff that is not a persistence instant", async () => {
  const db = new AuthorityDb(tempDb()); opened.push(db);
  await db.migrate();
  new LocalTimelineSnapshotStore(db).register(LOCAL_CHAIN_TASK_ID);
  for (const value of ["2026-08-28", "", "2026-02-30T00:00:00.000Z", 1, null]) {
    expect(() => selectLocalObservationRetention(db.db, value)).toThrow("LOCAL_RETENTION_CUTOFF_INVALID");
  }
});
