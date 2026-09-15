import { afterEach, expect, it } from "vitest";
import { AuthorityDb } from "../../src/db.js";
import { todayProjection } from "../../src/dashboard/personal-today.js";
import { admitLocalTimelineObservation, readCurrentLocalTimelineObservation } from "../../src/local-timeline-observation.js";
import { LocalTimelineSnapshotStore } from "../../src/local-timeline-snapshot-store.js";
import { MemoryProjectionAuthority } from "../../src/memory-projection-authority.js";
import { recordCandidateTaskSource } from "../../src/memory-candidate-task-source.js";
import { AT, CLI_AT, dailyProductionChild as child, HARNESS, LIVE_SOURCE, TASK,
  prepareDailyProductionChain } from "../fixtures/daily-production-chain.js";
import { closeMemoryDatabase, type MemoryDatabase } from "../fixtures/memory-candidate-store.js";

/**
 * §7.2.3 and §7.2.5 on the production path.
 *
 * `tests/integration/daily-morning-cli-process.test.ts` runs the same six conditions with no
 * provider configured, so `dailyProductionPolicy` returns no `memory_reference` and production
 * short-circuits at `personal-daily-production.ts` before it reaches any of them: what that file
 * proves is the publish-only path's abstention. Every case here runs with a real stdio provider
 * present, the owner's confirmation on record and an authorized workflow - so production does run,
 * and what each case asserts is what production did with the condition.
 *
 * Two outcomes appear, and the difference is the point:
 *
 * - the local task-timeline collection is an *advisory* source. It cannot carry a current Linux
 *   fact (§7.1.2), so it is never a production input: holding it, clearing its snapshot, deleting
 *   its subject, replacing it or capping it leaves the run producing from the live fact beside it.
 *   Those cases assert the produced outcome, and `docs/daily-production-contract-2026-09-14.md`
 *   records why.
 * - a condition on something production does rest on - a current observation, the memory behind
 *   the principle, the candidate's originating task - withholds before anything is written: zero
 *   recommendations and zero contexts, and the brief abstains rather than failing.
 *
 * Every producing case binds its assertion to the recommendation id the run itself produced, read
 * back out of `personal_recommendations`. No fixture inserts a recommendation here (§7.3, B3).
 *
 * The clock is fixed and injected through `execute()`'s dependencies by the compiled-CLI harness;
 * no product clock bypass is added, and the instants stay inside the shipped policy's effective
 * window and the configured 600s recovery window.
 */
const databases: MemoryDatabase[] = [];
afterEach(() => { for (const database of databases.splice(0)) closeMemoryDatabase(database); });

const prepared = async () => {
  const f = await prepareDailyProductionChain({ ownerDecision: "confirm", ownerAuthorization: true });
  databases.push(f.database);
  return f;
};

/** Everything the exited process left behind, through a connection it never shared. */
function reopen(path: string, at: string) {
  const db = new AuthorityDb(path);
  try {
    return {
      rows: db.db.prepare("SELECT recommendation_id FROM personal_recommendations ORDER BY recommendation_id")
        .pluck().all() as string[],
      contexts: Number(db.db.prepare("SELECT COUNT(*) FROM personal_context_snapshots").pluck().get()),
      snapshots: Number(db.db.prepare(
        "SELECT COUNT(*) FROM local_timeline_subjects WHERE collection_id IS NOT NULL").pluck().get()),
      brief: todayProjection(db, new Date(at))["brief"] as
        { state: string; item_count: number; brief_id: string | null },
      detail: String(db.db.prepare(
        `SELECT detail_json FROM daily_loop_steps WHERE step_key='morning_reconcile' AND state='completed'
         ORDER BY updated_at DESC LIMIT 1`).pluck().get()),
      run: db.db.prepare("SELECT state,failure_code FROM daily_loop_runs WHERE loop_date='2026-08-29' AND phase='morning'")
        .get() as { state: string; failure_code: string | null },
    };
  } finally { db.close(); }
}

const offset = (ms: number) => new Date(Date.parse(AT) + ms).toISOString();
const morning = (path: string, input: string, at: string,
  provider: Readonly<Record<string, string>>) => child([HARNESS, path, input, at], provider);

/** The run produced, and the brief it published carries that row - not a fixture's. */
function expectProduced(after: ReturnType<typeof reopen>) {
  expect(after.run).toMatchObject({ state: "completed", failure_code: null });
  expect(after.rows).toHaveLength(1);
  expect(after.contexts).toBe(1);
  expect(after.brief).toMatchObject({ state: "ready", item_count: 1 });
  expect(JSON.parse(after.detail)["abstention_reasons"]).toEqual([]);
  expect(after.detail).toContain(after.rows[0]);
}

/**
 * Production withheld before assembling anything, and the brief reports that as an abstention.
 *
 * Zero contexts is the stronger half: a condition on a production input is answered before
 * `produceDailyRecommendation` is reached, so the run leaves no stored context behind either.
 */
function expectWithheld(after: ReturnType<typeof reopen>) {
  expect(after.run).toMatchObject({ state: "completed", failure_code: null });
  expect(after.rows).toEqual([]);
  expect(after.contexts).toBe(0);
  expect(after.brief).toMatchObject({ state: "no_data", item_count: 0 });
  expect(JSON.parse(after.detail)["abstention_reasons"]).toEqual(["no_data"]);
}

// ---------------------------------------------------------------------------------------------
// The advisory local collection. Each condition really holds - asserted here, before the run - and
// the run still produces, because the fact it cites is the live observation beside it.
// ---------------------------------------------------------------------------------------------

it("produces from the live fact when the local collection is held", async () => {
  const f = await prepared();
  const db = new AuthorityDb(f.path);
  try {
    const observation = String(db.db.prepare("SELECT observation_id FROM personal_observations WHERE source_id=?")
      .pluck().get("src:pos:v1:task-timeline:local"));
    new LocalTimelineSnapshotStore(db, () => new Date(CLI_AT)).setHeld(TASK, true);
    // The hold really took: the local observation is no longer a current one.
    expect(() => readCurrentLocalTimelineObservation(db, observation, () => new Date(CLI_AT)))
      .toThrow("LOCAL_OBSERVATION_SOURCE_UNAVAILABLE");
  } finally { db.close(); }

  const run = morning(f.path, f.input, CLI_AT, f.provider);

  expect(run.stderr).toBe("");
  expect(run.status).toBe(0);
  expectProduced(reopen(f.path, CLI_AT));
}, 120_000);

// The snapshot is cleared only once its own window has passed, and that instant is also past both
// observations' expiry - so this case carries two conditions at once and withholds for the one
// production rests on. A cleared snapshot at an instant where the observations are still current is
// not reachable without writing to the store's table, which would be a forgery, not a test.
it("withholds when the local snapshot was cleared and no observation is current", async () => {
  const f = await prepared();
  const at = offset(400_000);
  const db = new AuthorityDb(f.path);
  try { expect(new LocalTimelineSnapshotStore(db, () => new Date(at)).expire()).toBeGreaterThan(0); }
  finally { db.close(); }

  const run = morning(f.path, f.input, at, f.provider);

  expect(run.status).toBe(0);
  const after = reopen(f.path, at);
  expect(after.snapshots).toBe(0);
  expectWithheld(after);
}, 120_000);

it("produces from the live fact when the local collection's own subject is gone", async () => {
  const f = await prepared();
  const db = new AuthorityDb(f.path);
  try {
    // source_missing, not snapshot_missing: the store reports it only when TaskTimeline raises
    // TASK_TIMELINE_NOT_FOUND for the subject.
    db.db.prepare("DELETE FROM gjc_intents WHERE continuation_id=?").run(TASK);
    expect(() => new LocalTimelineSnapshotStore(db, () => new Date(CLI_AT)).refresh(TASK)).toThrow();
  } finally { db.close(); }

  const run = morning(f.path, f.input, CLI_AT, f.provider);

  expect(run.status).toBe(0);
  expectProduced(reopen(f.path, CLI_AT));
}, 120_000);

it("produces from the live fact when the local collection was replaced", async () => {
  const f = await prepared();
  const at = offset(10_000);
  const db = new AuthorityDb(f.path);
  try {
    const observation = String(db.db.prepare("SELECT observation_id FROM personal_observations WHERE source_id=?")
      .pluck().get("src:pos:v1:task-timeline:local"));
    new LocalTimelineSnapshotStore(db, () => new Date(at)).refresh(TASK);
    // The superseded observation is no longer current, so it cannot re-enter as current evidence.
    expect(() => readCurrentLocalTimelineObservation(db, observation, () => new Date(at)))
      .toThrow("LOCAL_OBSERVATION_SOURCE_UNAVAILABLE");
  } finally { db.close(); }

  const run = morning(f.path, f.input, at, f.provider);

  expect(run.status).toBe(0);
  expectProduced(reopen(f.path, at));
}, 120_000);

// §7.2.5: a capped collection is a truncated read, never a normal empty result. TaskTimeline drops
// events until the canonical context fits, so growing the subject's intent log past that budget is
// what makes the state reachable without touching the product.
it("refuses a capped collection and still produces from the live fact", async () => {
  const f = await prepared();
  const db = new AuthorityDb(f.path);
  try {
    const intent = String(db.db.prepare("SELECT intent_id FROM gjc_intents WHERE continuation_id=?")
      .pluck().get(TASK));
    const insert = db.db.prepare(`INSERT INTO gjc_intent_events(intent_id,event_type,payload_json,created_at)
      VALUES(?,'progress',?,'2026-08-28T21:00:00.000Z')`);
    const payload = JSON.stringify({ note: "x".repeat(4096) });
    db.db.transaction(() => { for (let index = 0; index < 64; index++) insert.run(intent, payload); })();

    const store = new LocalTimelineSnapshotStore(db, () => new Date(CLI_AT));
    const snapshot = store.refresh(TASK);
    expect(snapshot.state).toBe("capped");
    expect(store.read(TASK, snapshot.collection_id)).toMatchObject({ state: "unavailable", reason: "capped" });
    // A capped collection is never admitted, so no observation can cite a truncated read.
    expect(() => admitLocalTimelineObservation(db, TASK, snapshot.collection_id,
      () => new Date(CLI_AT))).toThrow("LOCAL_OBSERVATION_SOURCE_UNAVAILABLE");
  } finally { db.close(); }

  const run = morning(f.path, f.input, CLI_AT, f.provider);

  expect(run.status).toBe(0);
  expectProduced(reopen(f.path, CLI_AT));
}, 120_000);

// ---------------------------------------------------------------------------------------------
// Conditions on what production does rest on. Each withholds before anything is written.
// ---------------------------------------------------------------------------------------------

// §7.2.3 expiry: both stored observations carry their own windows, and past them there is no
// current observation to cite. +400s is still inside the configured 600s recovery window, so the
// run is one the CLI can still recover - the expiry is the observations', not the run's.
it("withholds when every stored observation expired before the run", async () => {
  const f = await prepared();
  const at = offset(400_000);

  const run = morning(f.path, f.input, at, f.provider);

  expect(run.stderr).toBe("");
  expect(run.status).toBe(0);
  expectWithheld(reopen(f.path, at));
}, 120_000);

// §7.2.3 quarantine, on the live observation the fact is cited from. The collection seams refuse a
// suppressed observation when they are the ones being read, but the producer reads stored rows, so
// it asks the projection authority itself.
it("withholds when the cited observation's projection is quarantined", async () => {
  const f = await prepared();
  const db = new AuthorityDb(f.path);
  try {
    const id = String(db.db.prepare("SELECT observation_id FROM personal_observations WHERE source_id=?")
      .pluck().get(LIVE_SOURCE));
    new MemoryProjectionAuthority(db).quarantineUnresolved(
      { kind: "observation", id, component_id: id }, new Date(CLI_AT));
  } finally { db.close(); }

  const run = morning(f.path, f.input, CLI_AT, f.provider);

  expect(run.stderr).toBe("");
  expect(run.status).toBe(0);
  expectWithheld(reopen(f.path, CLI_AT));
}, 120_000);

// §7.2.3 quarantine, on the memory the principle rests on. The provider still serves the record;
// the reference seam refuses to call it confirmed, so there is no principle to propose under.
it("withholds when the memory candidate behind the principle is quarantined", async () => {
  const f = await prepared();
  const db = new AuthorityDb(f.path);
  try {
    new MemoryProjectionAuthority(db).quarantineUnresolved(
      { kind: "dashboard_projection", id: f.candidateId, component_id: f.candidateId }, new Date(CLI_AT));
  } finally { db.close(); }

  const run = morning(f.path, f.input, CLI_AT, f.provider);

  expect(run.stderr).toBe("");
  expect(run.status).toBe(0);
  expectWithheld(reopen(f.path, CLI_AT));
}, 120_000);

// §7.2.3 real source missing, end to end through the compiled CLI: the owner hides the task the
// memory was derived from. The seam answers that as an unavailable gap and the run withholds.
it("withholds when the owner closed the task the memory came from", async () => {
  const f = await prepared();
  const origin = "task:memory-origin";
  const db = new AuthorityDb(f.path);
  try {
    recordCandidateTaskSource(db, f.candidateId, origin, new Date(CLI_AT));
    new MemoryProjectionAuthority(db).quarantineUnresolved(
      { kind: "task_timeline", id: origin, component_id: origin }, new Date(CLI_AT));
  } finally { db.close(); }

  const run = morning(f.path, f.input, CLI_AT, f.provider);

  expect(run.stderr).toBe("");
  expect(run.status).toBe(0);
  expectWithheld(reopen(f.path, CLI_AT));
}, 120_000);

// The collection receipt is the one source that cannot go missing: it is the immutable manifest
// `collectedObservation` reads to decide whether this machine really admitted the fact. Deleting it
// is refused by the product, so the run still produces - recorded here so "source missing" is not
// left looking untested on the production input.
it("refuses to let the collection receipt be removed and still produces", async () => {
  const f = await prepared();
  const db = new AuthorityDb(f.path);
  try {
    expect(() => db.db.prepare("DELETE FROM observation_refresh_receipts").run())
      .toThrow("OBSERVATION_REFRESH_IMMUTABLE");
  } finally { db.close(); }

  const run = morning(f.path, f.input, CLI_AT, f.provider);

  expect(run.status).toBe(0);
  expectProduced(reopen(f.path, CLI_AT));
}, 120_000);
