import { rmSync } from "node:fs";
import { dirname } from "node:path";
import { afterEach, expect, it } from "vitest";
import { AuthorityDb, DailyLoopStore, createStoredMorningDailyLoop, dailyLoopUsage } from "../../src/index.js";
import { canonicalize } from "../../src/canonical.js";
import type { DailyLoopOptions } from "../../src/daily-loop-types.js";
import { todayProjection } from "../../src/dashboard/personal-today.js";
import { tempDb } from "../helpers.js";
import { morningPublicationFixture, PUBLICATION_AT, forgetSecondPublicationSource } from "../fixtures/morning-publication.js";

const opened: AuthorityDb[] = [];
afterEach(() => { for (const db of opened.splice(0)) { db.close(); rmSync(dirname(db.filename), { recursive: true, force: true }); } });
const day = "2026-08-28";
function options(clock: () => Date, overrides: Partial<DailyLoopOptions> = {}): DailyLoopOptions {
  return { time_zone: "Asia/Seoul", owner_id: "morning-publisher", lease_ms: 300_000, deadline_ms: 600_000,
    recovery_window_ms: 600_000, recovery_lookback_days: 2, refresh_freshness_ms: 600_000,
    budgets: { max_items: 8, max_work: 8, max_bytes: 8192 }, clock,
    event_source: { drain: () => [] }, refresh_reader: { read: () => null }, ...overrides };
}
async function setup(overrides: Partial<DailyLoopOptions> = {}, empty = false) {
  const db = new AuthorityDb(tempDb()); opened.push(db);
  const fixture = await morningPublicationFixture(db, { preceding: true, empty });
  let now = PUBLICATION_AT; const config = options(() => now, overrides);
  return { db, ...fixture, config, loop: createStoredMorningDailyLoop(db, config), setClock: (value: Date) => { now = value; } };
}
const changes = (db: AuthorityDb) => db.db.prepare("SELECT total_changes() AS n").get();

it("executes the refresh and real morning publication through the existing finish path with actual usage", async () => {
  const f = await setup(); expect(f.loop.finish(f.claim)).toBe(true);
  expect(f.db.db.prepare("SELECT state FROM daily_loop_runs WHERE run_id=?").get(f.run)).toEqual({ state: "completed" });
  const summary = todayProjection(f.db, PUBLICATION_AT)["brief"];
  expect(summary).toMatchObject({ state: "degraded", item_count: 1 });
  const details = f.db.db.prepare("SELECT detail_json FROM daily_loop_steps ORDER BY sequence").all() as { detail_json: string }[];
  const expectedBytes = details.reduce((total, row) => total + Buffer.byteLength(row.detail_json), 0);
  const before = changes(f.db);
  expect(dailyLoopUsage(f.db, day)).toEqual({ items: 2, work: 2, bytes: expectedBytes });
  expect(expectedBytes).toBeGreaterThan(3000); expect(changes(f.db)).toEqual(before);
  expect(JSON.parse(details[1]!.detail_json)).not.toHaveProperty("boundary");
});

it.each([
  [{ max_items: 1, max_work: 8, max_bytes: 8192 }, "BUDGET_ITEMS_EXHAUSTED"],
  [{ max_items: 8, max_work: 1, max_bytes: 8192 }, "BUDGET_WORK_EXHAUSTED"],
  [{ max_items: 8, max_work: 8, max_bytes: 300 }, "BUDGET_BYTES_EXHAUSTED"],
] as const)("rolls back an over-budget publication and keeps prior refresh usage %j", async (budgets, code) => {
  const f = await setup({ budgets }); expect(f.loop.finish(f.claim)).toBe(false);
  expect(f.store.steps(f.run).map(step => step.state)).toEqual(["completed", "pending"]);
  expect(f.db.db.prepare("SELECT state,failure_code FROM daily_loop_runs WHERE run_id=?").get(f.run))
    .toEqual({ state: "failed", failure_code: code });
  expect(f.db.db.prepare("SELECT COUNT(*) AS n FROM memory_projection_dependencies WHERE projection_kind='morning_brief'").get()).toEqual({ n: 0 });
  expect(dailyLoopUsage(f.db, day)).toMatchObject({ items: 1, work: 1 });
});

it("resumes through cycle after reopen without repeating the completed refresh or charging it twice", async () => {
  let refreshCalls = 0; const f = await setup({ refresh_reader: { read: () => { refreshCalls++; return null; } } });
  expect(f.loop.runNext(f.claim)).toBe(true); const saved = f.db.db.prepare("SELECT * FROM daily_loop_steps WHERE sequence=1").get();
  f.db.close(); opened.pop(); const reopened = new AuthorityDb(f.db.filename); opened.push(reopened);
  const now = new Date(PUBLICATION_AT.getTime() + 300_001);
  const loop = createStoredMorningDailyLoop(reopened, options(() => now, {
    refresh_reader: { read: () => { refreshCalls++; throw new Error("REPEATED_REFRESH"); } },
  }));
  expect((await loop.cycle()).completed_run_ids).toEqual([f.run]);
  expect(refreshCalls).toBe(1); expect(dailyLoopUsage(reopened, day)).toMatchObject({ items: 2, work: 2 });
  expect(reopened.db.prepare("SELECT * FROM daily_loop_steps WHERE sequence=1").get()).toEqual(saved);
  const before = changes(reopened); expect((await loop.cycle()).completed_run_ids).toEqual([]); expect(changes(reopened)).toEqual(before);
});

it("does not refund completed usage when memory deletion hides the published run", async () => {
  const f = await setup(); f.loop.finish(f.claim); const used = dailyLoopUsage(f.db, day);
  forgetSecondPublicationSource(f.db);
  expect(todayProjection(f.db, PUBLICATION_AT)["brief"]).toMatchObject({ state: "no_data" });
  expect(dailyLoopUsage(f.db, day)).toEqual(used);
});

it("refuses unaccountable historical placeholders instead of treating their cost as zero", async () => {
  const f = await setup();
  f.store.completeStep({ claim: f.claim, step: f.store.steps(f.run)[0], detail: { boundary: "no_external_effect" }, at: PUBLICATION_AT });
  const before = changes(f.db);
  expect(() => f.loop.finish(f.claim)).toThrow("DAILY_LOOP_INTEGRITY_FAILURE");
  expect(changes(f.db)).toEqual(before);
});

it("holds an unimplemented evening phase without a completed placeholder", async () => {
  const db = new AuthorityDb(tempDb()); opened.push(db); await db.migrate();
  const store = new DailyLoopStore(db); const at = new Date("2026-08-28T12:30:00.000Z");
  const loop = createStoredMorningDailyLoop(db, options(() => at));
  const prepared = loop.prepare({ kind: "scheduled" }); if (prepared.kind !== "prepared") throw new Error("EXPECTED_SCHEDULE");
  const claim = loop.claim(prepared.run_id); const before = changes(db);
  expect(() => loop.finish(claim)).toThrow("DAILY_LOOP_HANDLER_UNAVAILABLE");
  expect(store.steps(prepared.run_id)[0]?.state).toBe("pending"); expect(changes(db)).toEqual(before);
});

it("accepts the exact output-byte budget and permits an empty no-data brief", async () => {
  const f = await setup({}, true); f.loop.finish(f.claim);
  const used = dailyLoopUsage(f.db, day); expect(used).toMatchObject({ items: 1, work: 2 });
  const g = await setup({ budgets: { max_items: 1, max_work: 2, max_bytes: used.bytes } }, true);
  expect(g.loop.finish(g.claim)).toBe(true); expect(dailyLoopUsage(g.db, day)).toEqual(used);
  const detail = g.db.db.prepare("SELECT detail_json FROM daily_loop_steps WHERE sequence=2").get() as { detail_json: string };
  expect(detail.detail_json).toBe(canonicalize(JSON.parse(detail.detail_json)));
});

it("rolls back a refresh result when its completion consumes the remaining lease", async () => {
  const f = await setup(); let calls = 0;
  const loop = createStoredMorningDailyLoop(f.db, { ...f.config,
    clock: () => new Date(PUBLICATION_AT.getTime() + (calls++ === 0 ? 0 : 300_000)) });
  const steps = f.db.db.prepare("SELECT * FROM daily_loop_steps").all();
  const checkpoints = f.db.db.prepare("SELECT * FROM daily_loop_checkpoints").all();
  expect(() => loop.runNext(f.claim)).toThrow("DAILY_LOOP_STALE_LEASE");
  expect(f.db.db.prepare("SELECT * FROM daily_loop_steps").all()).toEqual(steps);
  expect(f.db.db.prepare("SELECT * FROM daily_loop_checkpoints").all()).toEqual(checkpoints);
  expect(dailyLoopUsage(f.db, day)).toEqual({ items: 0, work: 0, bytes: 0 });
});

it("rejects clock rollback between result completion and final usage validation", async () => {
  const f = await setup(); const offsets = [0, 100, 50];
  const loop = createStoredMorningDailyLoop(f.db, { ...f.config,
    clock: () => new Date(PUBLICATION_AT.getTime() + (offsets.shift() ?? 50)) });
  expect(() => loop.runNext(f.claim)).toThrow("DAILY_LOOP_STALE_LEASE");
  expect(f.store.steps(f.run).map(step => step.state)).toEqual(["pending", "pending"]);
  expect(dailyLoopUsage(f.db, day)).toEqual({ items: 0, work: 0, bytes: 0 });
});

it("rejects a final run completion before its last completed step with the typed lease error", async () => {
  const f = await setup(); f.loop.runNext(f.claim); f.setClock(new Date(PUBLICATION_AT.getTime() + 100));
  f.loop.runNext(f.claim); const offsets = [100, 100, 50];
  const loop = createStoredMorningDailyLoop(f.db, { ...f.config,
    clock: () => new Date(PUBLICATION_AT.getTime() + (offsets.shift() ?? 50)) });
  expect(() => loop.finish(f.claim)).toThrow("DAILY_LOOP_STALE_LEASE");
  expect(f.db.db.prepare("SELECT state FROM daily_loop_runs WHERE run_id=?").get(f.run)).toEqual({ state: "running" });
  expect(f.store.steps(f.run).map(step => step.state)).toEqual(["completed", "completed"]);
});

it("holds same-day legacy event output until real event usage can be verified", async () => {
  const f = await setup(); const prepared = f.loop.prepare({ kind: "event", event_id: "legacy-event",
    occurred_at: PUBLICATION_AT.toISOString(), critical: false, items: 1, work: 1, bytes: 16 });
  if (prepared.kind !== "prepared") throw new Error("EXPECTED_EVENT");
  const eventRun = prepared.run_id;
  const claim = f.store.claim({ run_id: eventRun, owner_id: "legacy", at: PUBLICATION_AT, lease_ms: 300_000 });
  f.store.completeStep({ claim, step: f.store.steps(eventRun)[0], at: PUBLICATION_AT,
    detail: { event: "event:legacy-event", boundary: "no_external_effect" } });
  const before = changes(f.db);
  expect(() => f.loop.finish(f.claim)).toThrow("DAILY_LOOP_INTEGRITY_FAILURE");
  expect(changes(f.db)).toEqual(before);
});
