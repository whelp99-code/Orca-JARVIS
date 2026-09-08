import { rmSync } from "node:fs";
import { dirname } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AuthorityDb } from "../../src/db.js";
import { DailyControlLoop } from "../../src/daily-loop-service.js";
import { DailyLoopStore } from "../../src/daily-loop-store.js";
import type { DailyLoopOptions } from "../../src/daily-loop-types.js";
import { tempDb } from "../helpers.js";

const databases: AuthorityDb[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) { db.close(); rmSync(dirname(db.filename), { recursive: true, force: true }); }
});
async function fixture(overrides: Partial<DailyLoopOptions> = {}) {
  const db = new AuthorityDb(tempDb()); databases.push(db); await db.migrate();
  let now = new Date("2026-09-07T22:15:00.000Z");
  const input: DailyLoopOptions = {
    time_zone: "Asia/Seoul", owner_id: "daily-result-test", lease_ms: 60_000, deadline_ms: 600_000,
    recovery_window_ms: 86_400_000, recovery_lookback_days: 2, refresh_freshness_ms: 60_000,
    budgets: { max_items: 8, max_work: 8, max_bytes: 4096 }, clock: () => now,
    event_source: { drain: () => [] }, refresh_reader: { read: () => null }, ...overrides,
  };
  return { db, loop: new DailyControlLoop(new DailyLoopStore(db), input), setNow: (value: Date) => { now = value; } };
}

describe("daily loop completion results", () => {
  it.each([
    ["cycle", "items"], ["cycle", "work"], ["cycle", "bytes"],
    ["startup", "items"], ["startup", "work"], ["startup", "bytes"],
  ] as const)("does not report %s %s budget failures as completed", async (entry, dimension) => {
    const budgets = { max_items: 8, max_work: 8, max_bytes: 4096, [`max_${dimension}`]: 0 };
    const { db, loop } = await fixture({ budgets });
    const result = await loop[entry]();
    const rows = db.db.prepare("SELECT state,failure_code FROM daily_loop_runs").all();
    expect(rows).toHaveLength(entry === "cycle" ? 1 : 3);
    expect(rows).toEqual(rows.map(() => ({ state: "failed", failure_code: `BUDGET_${dimension.toUpperCase()}_EXHAUSTED` })));
    expect(result.completed_run_ids).toEqual([]);
    const before = db.db.prepare("SELECT total_changes() AS n").get();
    expect((await loop[entry]()).completed_run_ids).toEqual([]);
    expect(db.db.prepare("SELECT total_changes() AS n").get()).toEqual(before);
  });

  it("reports no completion when the configured execution deadline is zero", async () => {
    const { db, loop } = await fixture({ deadline_ms: 0 });
    expect((await loop.cycle()).completed_run_ids).toEqual([]);
    expect(db.db.prepare("SELECT state,failure_code FROM daily_loop_runs").get())
      .toEqual({ state: "failed", failure_code: "DEADLINE_EXHAUSTED" });
  });

  it.each([0, 1])("does not backdate step completion when refresh returns at lease expiry + %i", async delta => {
    const { db, loop, setNow } = await fixture({ refresh_reader: { read: at => {
      setNow(new Date(at.getTime() + 60_000 + delta)); return null;
    } } });
    const prepared = loop.prepare({ kind: "scheduled" });
    if (prepared.kind !== "prepared") throw new Error("expected scheduled run");
    const claim = loop.claim(prepared.run_id);
    expect(() => loop.runNext(claim)).toThrow("DAILY_LOOP_STALE_LEASE");
    expect(db.db.prepare("SELECT state FROM daily_loop_steps ORDER BY sequence").all())
      .toEqual([{ state: "pending" }, { state: "pending" }]);
    expect(db.db.prepare("SELECT count(*) AS n FROM daily_loop_checkpoints WHERE step_id IS NOT NULL").get()).toEqual({ n: 0 });
  });

  it("keeps deadline failure terminal after the last step without trying to complete the run", async () => {
    const { db, loop, setNow } = await fixture({ recovery_window_ms: 0, recovery_lookback_days: 1, deadline_ms: 1000 });
    const prepared = loop.prepare({ kind: "scheduled" });
    if (prepared.kind !== "prepared") throw new Error("expected scheduled run");
    const claim = loop.claim(prepared.run_id);
    expect(loop.runNext(claim)).toBe(true); expect(loop.runNext(claim)).toBe(true);
    setNow(new Date(claim.deadline_at));
    expect(loop.finish(claim)).toBe(false);
    expect(db.db.prepare("SELECT state,failure_code,result_digest FROM daily_loop_runs").get())
      .toEqual({ state: "failed", failure_code: "DEADLINE_EXHAUSTED", result_digest: null });
    expect(db.db.prepare("SELECT count(*) AS n FROM daily_loop_checkpoints WHERE step_id IS NULL AND state='completed'").get())
      .toEqual({ n: 0 });
  });

  it("evaluates refresh freshness at observation completion instead of its start", async () => {
    const { db, loop, setNow } = await fixture({ refresh_freshness_ms: 1000, refresh_reader: { read: at => {
      setNow(new Date(at.getTime() + 2000));
      return { schema_version: 1, refresh_id: "slow-refresh", state: "completed",
        completed_at: at.toISOString(), protocol_version: 1, capped: false };
    } } });
    const prepared = loop.prepare({ kind: "scheduled" });
    if (prepared.kind !== "prepared") throw new Error("expected scheduled run");
    expect(loop.runNext(loop.claim(prepared.run_id))).toBe(true);
    const row = db.db.prepare("SELECT detail_json,updated_at FROM daily_loop_steps WHERE sequence=1").get() as
      { detail_json: string; updated_at: string };
    expect(JSON.parse(row.detail_json)).toEqual({ state: "degraded", reason: "refresh_stale", refresh_id: "slow-refresh" });
    expect(row.updated_at).toBe("2026-09-07T22:15:02.000Z");
  });

  it("reports only the durably completed run and does not report it again", async () => {
    const { db, loop } = await fixture();
    const result = await loop.cycle();
    expect(result.completed_run_ids).toHaveLength(1);
    expect(db.db.prepare("SELECT run_id FROM daily_loop_runs WHERE state='completed' AND result_digest IS NOT NULL").all())
      .toEqual(result.completed_run_ids.map(run_id => ({ run_id })));
    const before = db.db.prepare("SELECT total_changes() AS n").get();
    expect((await loop.cycle()).completed_run_ids).toEqual([]);
    expect(db.db.prepare("SELECT total_changes() AS n").get()).toEqual(before);
  });
});
