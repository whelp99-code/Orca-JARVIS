import { afterEach, expect, it } from "vitest";
import { AuthorityDb, createStoredMorningDailyLoop, dailyLoopUsage } from "../../src/index.js";
import type { DailyLoopOptions } from "../../src/daily-loop-types.js";
import { todayProjection } from "../../src/dashboard/personal-today.js";
import { MemoryProjectionAuthority } from "../../src/memory-projection-authority.js";
import { projectRecommendations } from "../../src/recommendation-projection.js";
import { localObservationChain, LOCAL_CHAIN_AT, LOCAL_CHAIN_RECOMMENDATION_ID, LOCAL_CHAIN_TASK_ID }
  from "../fixtures/local-observation-chain.js";
import { morningPublicationFixture, PUBLICATION_AT } from "../fixtures/morning-publication.js";
import { tempDb } from "../helpers.js";

const LOOP_DATE = "2026-08-28";
const opened: AuthorityDb[] = [];
afterEach(() => { for (const db of opened.splice(0)) db.close(); });

function options(clock: () => Date, overrides: Partial<DailyLoopOptions> = {}): DailyLoopOptions {
  return { time_zone: "Asia/Seoul", owner_id: "morning-publisher", lease_ms: 300_000, deadline_ms: 600_000,
    recovery_window_ms: 600_000, recovery_lookback_days: 2, refresh_freshness_ms: 600_000,
    budgets: { max_items: 8, max_work: 8, max_bytes: 8192 }, clock,
    event_source: { drain: () => [] }, refresh_reader: { read: () => null }, ...overrides };
}

/** One daily morning run whose only publishable source is the local observation chain. */
async function setup(at: Date = PUBLICATION_AT) {
  const db = new AuthorityDb(tempDb()); opened.push(db);
  const chain = await localObservationChain(db);
  const publication = await morningPublicationFixture(db, { preceding: true, empty: true });
  const config = options(() => at);
  return { db, timeline: chain.store, observation: chain.observation, ...publication, config,
    loop: createStoredMorningDailyLoop(db, config) };
}

type BriefSummary = { state: string; brief_id: string | null; generated_at: string | null; item_count: number };
const brief = (db: AuthorityDb, at: Date = PUBLICATION_AT) =>
  (todayProjection(db, at) as Record<string, unknown>)["brief"] as BriefSummary;
const nextActions = (db: AuthorityDb, at: Date = PUBLICATION_AT) =>
  (todayProjection(db, at) as Record<string, unknown>)["next_actions"] as readonly unknown[];
const reconcileSteps = (db: AuthorityDb) => db.db.prepare(
  "SELECT step_id,state FROM daily_loop_steps WHERE step_key='morning_reconcile' ORDER BY step_id").all();
const writes = (db: AuthorityDb) => db.db.prepare("SELECT total_changes() AS n").get();

it("publishes exactly one morning brief from the local observation chain under the daily lease", async () => {
  const f = await setup();
  expect(f.loop.finish(f.claim)).toBe(true);
  expect(f.db.db.prepare("SELECT state FROM daily_loop_runs WHERE run_id=?").get(f.run)).toEqual({ state: "completed" });
  const published = brief(f.db);
  expect(published).toMatchObject({ state: "ready", item_count: 1 });
  expect(published.brief_id).toMatch(/^morning-brief:v2:[0-9a-f]{64}$/);
  expect(published.generated_at).toBe(LOCAL_CHAIN_AT);
  expect(reconcileSteps(f.db)).toHaveLength(1);
  expect(dailyLoopUsage(f.db, LOOP_DATE)).toMatchObject({ items: 2, work: 2 });
  expect(f.db.db.prepare(
    "SELECT COUNT(*) AS n FROM memory_projection_dependencies WHERE projection_kind='morning_brief'")
    .get()).toEqual({ n: 1 });
});

it.each([
  ["held", (f: Awaited<ReturnType<typeof setup>>) => { f.timeline.setHeld(LOCAL_CHAIN_TASK_ID, true); }],
  ["replaced", (f: Awaited<ReturnType<typeof setup>>) => { f.timeline.refresh(LOCAL_CHAIN_TASK_ID); }],
  ["quarantined", (f: Awaited<ReturnType<typeof setup>>) => {
    new MemoryProjectionAuthority(f.db).quarantineUnresolved({ kind: "observation", id: f.observation.id,
      component_id: f.observation.id }, PUBLICATION_AT);
  }],
])("keeps a published brief readable but not current once its local source is %s", async (_label, disturb) => {
  const f = await setup();
  expect(f.loop.finish(f.claim)).toBe(true);
  const published = brief(f.db);
  disturb(f);
  const before = writes(f.db);
  const after = brief(f.db);
  expect(after.brief_id).toBe(published.brief_id);
  expect(after.generated_at).toBe(published.generated_at);
  expect(after.state).toBe("stale");
  expect(after.item_count).toBe(0);
  expect(nextActions(f.db)).toEqual([]);
  expect(projectRecommendations(f.db, LOCAL_CHAIN_AT).lifecycle_actions).toHaveLength(1);
  expect(reconcileSteps(f.db)).toHaveLength(1);
  expect(writes(f.db)).toEqual(before);
});

it("does not republish or duplicate the brief after a restart", async () => {
  const f = await setup();
  expect(f.loop.finish(f.claim)).toBe(true);
  const published = brief(f.db);
  const filename = f.db.filename;
  f.db.close(); opened.pop();
  const reopened = new AuthorityDb(filename); opened.push(reopened);
  const later = new Date(PUBLICATION_AT.getTime() + 60_000);
  const loop = createStoredMorningDailyLoop(reopened, options(() => later));
  expect((await loop.cycle()).completed_run_ids).toEqual([]);
  expect(reconcileSteps(reopened)).toHaveLength(1);
  expect(brief(reopened, later)).toEqual(published);
  expect(reopened.db.prepare("SELECT COUNT(*) AS n FROM daily_loop_runs").get()).toEqual({ n: 1 });
});

const reconcileDetail = (db: AuthorityDb): string => String(db.db.prepare(
  "SELECT detail_json FROM daily_loop_steps WHERE step_key='morning_reconcile'").pluck().get());

it("publishes an abstaining brief rather than stale items while the local source is held", async () => {
  const f = await setup();
  f.timeline.setHeld(LOCAL_CHAIN_TASK_ID, true);
  // The only cited source is unverifiable, so the run completes with an explicitly degraded brief
  // instead of wedging the morning step, and it carries none of the withdrawn content.
  expect(f.loop.finish(f.claim)).toBe(true);
  expect(f.db.db.prepare("SELECT state,failure_code FROM daily_loop_runs WHERE run_id=?").get(f.run))
    .toEqual({ state: "completed", failure_code: null });
  expect(f.store.steps(f.run).map(step => step.state)).toEqual(["completed", "completed"]);
  expect(brief(f.db)).toMatchObject({ state: "degraded", item_count: 0 });
  const detail = JSON.parse(reconcileDetail(f.db)) as Record<string, unknown>;
  expect(detail["abstention_reasons"]).toEqual(["no_authoritative_data"]);
  expect(detail["context_readiness"]).toBe("degraded");
  expect(detail["needs_you_first"]).toEqual([]);
  expect(reconcileDetail(f.db)).not.toContain("local-task-followup");
  // An empty lineage binds no brief dependency.
  expect(f.db.db.prepare(
    "SELECT COUNT(*) AS n FROM memory_projection_dependencies WHERE projection_kind='morning_brief'")
    .get()).toEqual({ n: 0 });
});

it("publishes no partial content when the local task source is gone", async () => {
  const f = await setup();
  f.db.db.prepare("DELETE FROM gjc_intents WHERE continuation_id=?").run(LOCAL_CHAIN_TASK_ID);
  expect(f.loop.finish(f.claim)).toBe(true);
  expect(reconcileSteps(f.db).map(step => (step as { state: string }).state)).toEqual(["completed"]);
  expect(brief(f.db)).toMatchObject({ state: "degraded", item_count: 0 });
  expect(reconcileDetail(f.db)).not.toContain("local-task-followup");
  expect(projectRecommendations(f.db, LOCAL_CHAIN_AT).next_actions).toEqual([]);
  expect(projectRecommendations(f.db, LOCAL_CHAIN_AT).warnings).toEqual([
    { recommendation_id: LOCAL_CHAIN_RECOMMENDATION_ID, code: "RECOMMENDATION_SOURCE_UNAVAILABLE",
      deadline: "2026-08-28T12:02:59.999Z" }]);
});

// The daily lease still runs until 12:05; only the cited context and recommendation have expired by then.
it("publishes an abstaining brief instead of expired items after the context deadline", async () => {
  const expired = new Date("2026-08-28T12:04:30.000Z");
  const f = await setup(expired);
  expect(f.loop.finish(f.claim)).toBe(true);
  const published = brief(f.db, expired);
  expect(published.brief_id).toMatch(/^morning-brief:v2:[0-9a-f]{64}$/);
  expect(published.item_count).toBe(0);
  expect(nextActions(f.db, expired)).toEqual([]);
});
