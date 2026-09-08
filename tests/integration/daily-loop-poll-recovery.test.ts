import { rmSync } from "node:fs";
import { dirname } from "node:path";
import { afterEach, expect, it } from "vitest";
import { AuthorityDb } from "../../src/db.js";
import { DailyControlLoop } from "../../src/daily-loop-service.js";
import { DailyLoopStore } from "../../src/daily-loop-store.js";
import { MemoryProjectionAuthority } from "../../src/memory-projection-authority.js";
import type { DailyLoopOptions } from "../../src/daily-loop-types.js";
import { tempDb } from "../helpers.js";

const databases: AuthorityDb[] = [];
afterEach(() => { for (const db of databases.splice(0)) { db.close(); rmSync(dirname(db.filename), { recursive: true, force: true }); } });
async function fixture(at: string, overrides: Partial<DailyLoopOptions> = {}) {
  const db = new AuthorityDb(tempDb()); databases.push(db); await db.migrate();
  let clock = new Date(at);
  const config: DailyLoopOptions = { time_zone: "Asia/Seoul", owner_id: "poll-owner", lease_ms: 1000, deadline_ms: 600_000,
    recovery_window_ms: 60_000, recovery_lookback_days: 2, refresh_freshness_ms: 60_000,
    budgets: { max_items: 8, max_work: 8, max_bytes: 4096 }, clock: () => clock,
    event_source: { drain: () => [] }, refresh_reader: { read: () => null }, ...overrides };
  const store = new DailyLoopStore(db);
  return { db, store, loop: new DailyControlLoop(store, config), config, setClock: (value: string) => { clock = new Date(value); } };
}
const changes = (db: AuthorityDb) => db.db.prepare("SELECT total_changes() AS n").get();

it.each(["2026-09-07T22:15:00.000Z", "2026-09-08T12:30:00.000Z"])("recovers a scheduled instant crossed by polling: %s", async scheduled => {
  const time = Date.parse(scheduled);
  const f = await fixture(new Date(time - 1).toISOString());
  expect((await f.loop.cycle()).completed_run_ids).toEqual([]);
  f.setClock(new Date(time + 1).toISOString());
  const result = await f.loop.cycle();
  expect(result.completed_run_ids).toHaveLength(1);
  expect(f.db.db.prepare("SELECT state,created_at FROM daily_loop_runs").all()).toEqual([{ state: "completed", created_at: scheduled }]);
  const before = changes(f.db);
  f.setClock(new Date(time + 100).toISOString());
  expect((await f.loop.cycle()).completed_run_ids).toEqual([]);
  expect(changes(f.db)).toEqual(before);
});

it.each([0, 1])("applies the recovery window at equality plus %i", async extra => {
  const f = await fixture("2026-09-07T22:14:59.999Z", { recovery_window_ms: 1000 });
  await f.loop.cycle(); f.setClock(new Date(Date.parse("2026-09-07T22:15:00.000Z") + 1000 + extra).toISOString());
  const result = await f.loop.cycle();
  expect(result.completed_run_ids).toHaveLength(extra === 0 ? 1 : 0);
  expect(f.db.db.prepare("SELECT state,failure_code FROM daily_loop_runs").get())
    .toEqual(extra === 0 ? { state: "completed", failure_code: null } : { state: "failed", failure_code: "MISSED_RECOVERY_WINDOW" });
});

it("continues a persisted partial run through cycle after the previous process lease expires", async () => {
  const f = await fixture("2026-09-07T22:15:00.000Z");
  const prepared = f.loop.prepare({ kind: "scheduled" });
  if (prepared.kind !== "prepared") throw new Error("scheduled run required");
  const claim = f.loop.claim(prepared.run_id); f.loop.runNext(claim);
  const saved = f.db.db.prepare("SELECT detail_json,result_digest FROM daily_loop_steps WHERE sequence=1").get();
  const other = new AuthorityDb(f.db.filename);
  try {
    const resumed = new DailyControlLoop(new DailyLoopStore(other), { ...f.config, owner_id: "other-process" });
    f.setClock("2026-09-07T22:15:00.999Z"); expect((await resumed.cycle()).completed_run_ids).toEqual([]);
    f.setClock(claim.lease_expires_at); expect((await resumed.cycle()).completed_run_ids).toEqual([prepared.run_id]);
    expect(other.db.prepare("SELECT state,lease_fence FROM daily_loop_runs").get()).toEqual({ state: "completed", lease_fence: 2 });
    expect(other.db.prepare("SELECT detail_json,result_digest FROM daily_loop_steps WHERE sequence=1").get()).toEqual(saved);
  } finally { other.close(); }
});

it("does not reclaim a suppressed run after lease expiry", async () => {
  const f = await fixture("2026-09-07T22:15:00.000Z");
  const prepared = f.loop.prepare({ kind: "scheduled" });
  if (prepared.kind !== "prepared") throw new Error("scheduled run required");
  const claim = f.loop.claim(prepared.run_id);
  new MemoryProjectionAuthority(f.db).quarantineUnresolved({ kind: "daily_run", id: prepared.run_id, component_id: prepared.run_id },
    new Date("2026-09-07T22:15:00.000Z"));
  f.setClock(claim.lease_expires_at); const before = changes(f.db);
  expect((await f.loop.cycle()).completed_run_ids).toEqual([]); expect(changes(f.db)).toEqual(before);
});

it("does not turn an earlier completed run into a missed failure during a later startup", async () => {
  const f = await fixture("2026-09-07T22:15:00.000Z"); await f.loop.cycle();
  const saved = f.db.db.prepare("SELECT run_id,state,result_digest FROM daily_loop_runs").get();
  f.setClock("2026-09-07T22:17:00.000Z");
  await expect(f.loop.startup()).resolves.toBeDefined();
  expect(f.db.db.prepare("SELECT run_id,state,result_digest FROM daily_loop_runs WHERE state='completed'").get()).toEqual(saved);
});

it("keeps the observation start when a callback crosses a scheduled instant", async () => {
  let first = true;
  const f = await fixture("2026-09-07T22:14:59.999Z", { event_source: { drain: () => {
    if (first) { first = false; f.setClock("2026-09-07T22:15:00.001Z"); } return [];
  } } });
  await f.loop.cycle();
  expect((await f.loop.cycle()).completed_run_ids).toHaveLength(1);
});

it("does not advance the observation cursor on failure or rewind it on clock rollback", async () => {
  let fail = false;
  const f = await fixture("2026-09-07T22:14:59.999Z", { event_source: { drain: () => { if (fail) throw new Error("drain failed"); return []; } } });
  await f.loop.cycle(); f.setClock("2026-09-07T22:15:00.001Z"); fail = true;
  await expect(f.loop.cycle()).rejects.toThrow("drain failed"); fail = false;
  expect((await f.loop.cycle()).completed_run_ids).toHaveLength(1);
  const before = changes(f.db); f.setClock("2026-09-07T22:14:00.000Z"); await f.loop.cycle();
  f.setClock("2026-09-07T22:15:00.002Z"); expect((await f.loop.cycle()).completed_run_ids).toEqual([]);
  expect(changes(f.db)).toEqual(before);
});

it.each([false, true])("skips a deadline-expired partial run during startup (started=%s)", async started => {
  const f = await fixture("2026-09-07T22:15:00.000Z");
  const prepared = f.loop.prepare({ kind: "scheduled" });
  if (prepared.kind !== "prepared") throw new Error("scheduled run required");
  const claim = f.loop.claim(prepared.run_id); if (started) f.loop.runNext(claim);
  const saved = f.db.db.prepare("SELECT * FROM daily_loop_runs WHERE run_id=?").get(prepared.run_id);
  f.setClock(claim.deadline_at);
  expect((await f.loop.startup()).completed_run_ids).toEqual([]);
  expect(f.db.db.prepare("SELECT * FROM daily_loop_runs WHERE run_id=?").get(prepared.run_id)).toEqual(saved);
});

it.each([false, true])("does not run a pending schedule after drain failure and recovery expiry (new process=%s)", async restart => {
  let fail = false;
  const f = await fixture("2026-09-07T22:14:59.999Z", { event_source: { drain: () => {
    if (fail) throw new Error("drain failed"); return [];
  } } });
  await f.loop.cycle(); f.setClock("2026-09-07T22:15:00.001Z"); fail = true;
  await expect(f.loop.cycle()).rejects.toThrow("drain failed"); fail = false;
  f.setClock("2026-09-07T22:16:00.001Z");
  const resumed = restart ? new DailyControlLoop(f.store, f.config) : f.loop;
  expect((await resumed.cycle()).completed_run_ids).toEqual([]);
  expect(f.db.db.prepare("SELECT state,failure_code,lease_fence FROM daily_loop_runs").get())
    .toEqual({ state: "failed", failure_code: "MISSED_RECOVERY_WINDOW", lease_fence: 0 });
});

it("checks the recovery window after a slow drain and prepares an exact schedule only once", async () => {
  let slow = false;
  const f = await fixture("2026-09-07T22:14:59.999Z", { event_source: { drain: () => {
    if (slow) f.setClock("2026-09-07T22:16:00.001Z"); return [];
  } } });
  await f.loop.cycle(); slow = true; f.setClock("2026-09-07T22:15:00.000Z");
  const result = await f.loop.cycle();
  expect(result.prepared.filter(item => item.kind === "prepared")).toHaveLength(1);
  expect(result.completed_run_ids).toEqual([]);
  expect(f.db.db.prepare("SELECT state,failure_code FROM daily_loop_runs").get())
    .toEqual({ state: "failed", failure_code: "MISSED_RECOVERY_WINDOW" });
});
