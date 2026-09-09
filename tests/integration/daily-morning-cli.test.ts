import { existsSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { execute } from "../../src/cli.js";
import { AuthorityDb } from "../../src/db.js";
import { DailyControlLoop, DailyLoopStore, createStoredMorningDailyLoop } from "../../src/daily-loop.js";
import { tempDb } from "../helpers.js";
import { MemoryProjectionAuthority } from "../../src/memory-projection-authority.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const base = { time_zone: "Asia/Seoul" as const, lease_ms: 300_000, deadline_ms: 600_000,
  recovery_window_ms: 600_000, recovery_lookback_days: 2, refresh_freshness_ms: 600_000,
  budgets: { max_items: 8, max_work: 8, max_bytes: 8192 } };
const config = { schema_version: 1, ...base };
async function fixture(override: object = {}) {
  const path = tempDb(); const root = dirname(path); roots.push(root);
  const input = join(root, "daily.json"); writeFileSync(input, JSON.stringify({ ...config, ...override }));
  const db = new AuthorityDb(path); await db.migrate(); db.close();
  return { path, input, args: ["daily", "morning", "--once", "--db", path, "--input", input] };
}
function rows(path: string) {
  const db = new AuthorityDb(path);
  try { return { runs: db.db.prepare("SELECT * FROM daily_loop_runs ORDER BY run_id").all(),
    steps: db.db.prepare("SELECT * FROM daily_loop_steps ORDER BY step_id").all(),
    checkpoints: db.db.prepare("SELECT * FROM daily_loop_checkpoints ORDER BY run_id,sequence").all() }; }
  finally { db.close(); }
}
const at = new Date("2026-08-27T22:15:00.005Z");

it("runs the real CLI handler after a delayed startup and preserves its completed ledger on replay", async () => {
  const f = await fixture();
  const first = await execute(f.args, { clock: () => at });
  expect(first).toMatchObject({ ok: true, command: "daily.morning", provider_refresh: "unavailable",
    automatic_operation: "hold", run: { state: "completed" }, usage: { items: 1, work: 2 } });
  expect(first.completed_run_ids).toHaveLength(1);
  const saved = rows(f.path);
  expect(saved.runs.every(row => (row as Record<string, unknown>).phase === "morning")).toBe(true);
  const replay = await execute(f.args, { clock: () => new Date(at.getTime() + 1000) });
  expect(replay.completed_run_ids).toEqual([]); expect(replay.usage).toEqual(first.usage); expect(rows(f.path)).toEqual(saved);
});

it("leaves an existing evening lease and its pending steps untouched", async () => {
  const f = await fixture(); const db = new AuthorityDb(f.path);
  const loop = new DailyControlLoop(new DailyLoopStore(db), { ...base, time_zone: "Asia/Seoul", owner_id: "evening",
    clock: () => new Date("2026-08-28T12:30:00.000Z"), refresh_reader: { read: () => null }, event_source: { drain: () => [] } });
  const prepared = loop.prepare({ kind: "scheduled" });
  if (prepared.kind !== "prepared") throw new Error("EXPECTED_EVENING");
  loop.claim(prepared.run_id); db.close();
  const before = rows(f.path);
  await expect(execute(f.args, { clock: () => new Date("2026-08-28T12:31:00.000Z") }))
    .rejects.toMatchObject({ code: "DAILY_LOOP_MISSED_RECOVERY_WINDOW" });
  const after = rows(f.path);
  expect(after.runs.filter(row => (row as Record<string, unknown>).phase === "evening")).toEqual(before.runs);
  expect(after.steps.filter(row => (row as Record<string, unknown>).run_id === prepared.run_id)).toEqual(before.steps);
  expect(after.checkpoints).toEqual(before.checkpoints);
});

it("reports budget failure without publishing the over-budget step", async () => {
  const f = await fixture({ budgets: { max_items: 8, max_work: 1, max_bytes: 8192 } });
  await expect(execute(f.args, { clock: () => at })).rejects.toMatchObject({ code: "DAILY_LOOP_BUDGET_WORK_EXHAUSTED" });
  const current = rows(f.path).steps.filter(row => String((row as Record<string, unknown>).created_at).startsWith("2026-08-27T22:15"));
  expect(current.map(row => (row as Record<string, unknown>).state).sort()).toEqual(["completed", "pending"]);
});

it("does not consume another phase's event source or prepare its schedule", async () => {
  const f = await fixture(); const db = new AuthorityDb(f.path);
  try {
    const loop = createStoredMorningDailyLoop(db, { ...base, time_zone: "Asia/Seoul", owner_id: "morning-only",
      clock: () => new Date("2026-08-28T12:30:00.000Z"), refresh_reader: { read: () => null },
      event_source: { drain: () => { throw new Error("UNSUPPORTED_EVENT_SOURCE_CONSUMED"); } } });
    expect((await loop.cycle()).prepared).toEqual([{ kind: "not_due" }]);
    expect(db.db.prepare("SELECT count(*) AS n FROM daily_loop_runs").get()).toEqual({ n: 0 });
  } finally { db.close(); }
});

it.each([{ unknown: true }, { lease_ms: -1 }, { budgets: { max_items: 8, max_work: 1, max_bytes: -1 } }])(
  "rejects invalid settings before preparing any daily runs %j", async override => {
    const f = await fixture(override); const before = rows(f.path);
    await expect(execute(f.args, { clock: () => at })).rejects.toMatchObject({ code: "DAILY_LOOP_CONFIG_INVALID" });
    expect(rows(f.path)).toEqual(before);
  });

it("rejects unsupported CLI flags before creating a database", async () => {
  const path = tempDb(); roots.push(dirname(path));
  await expect(execute(["daily", "morning", "--db", path, "--input", "missing", "--once", "--unknown"]))
    .rejects.toMatchObject({ code: "CLI_ARGUMENT_INVALID" });
  expect(existsSync(path)).toBe(false);
});

it("omits an earlier day's morning even when the configured recovery window crosses midnight", async () => {
  const f = await fixture({ recovery_window_ms: 86_400_000, recovery_lookback_days: 3 });
  const result = await execute(f.args, { clock: () => new Date("2026-08-28T15:01:00.000Z") });
  expect(result).toMatchObject({ run: null, completed_run_ids: [], usage: { items: 0, work: 0, bytes: 0 } });
  expect(rows(f.path).runs.every(row => (row as Record<string, unknown>).state === "failed")).toBe(true);
});

it.each(["daily_run", "daily_step", "morning_brief"] as const)("does not report a hidden %s as a usable completion", async kind => {
  const f = await fixture(); await execute(f.args, { clock: () => at }); const db = new AuthorityDb(f.path);
  const row = db.db.prepare(`SELECT r.run_id,s.step_id,s.detail_json FROM daily_loop_runs r
    JOIN daily_loop_steps s ON s.run_id=r.run_id WHERE r.state='completed' AND s.step_key='morning_reconcile'`).get() as
    { run_id: string; step_id: string; detail_json: string };
  const id = kind === "daily_run" ? row.run_id : kind === "daily_step" ? row.step_id : JSON.parse(row.detail_json).brief_id;
  new MemoryProjectionAuthority(db).quarantineUnresolved({ kind, id, component_id: id }, at); db.close();
  await expect(execute(f.args, { clock: () => at })).rejects.toMatchObject({ code: "DAILY_LOOP_RESULT_UNAVAILABLE" });
});

it.each(["active", "uncertain", "expired"] as const)("does not return CLI success for %s unfinished work", async state => {
  const f = await fixture(); const db = new AuthorityDb(f.path); const store = new DailyLoopStore(db);
  const loop = new DailyControlLoop(store, { ...base, owner_id: "other-process",
    clock: () => new Date("2026-08-27T22:15:00.000Z"), refresh_reader: { read: () => null }, event_source: { drain: () => [] } });
  const prepared = loop.prepare({ kind: "scheduled" }); if (prepared.kind !== "prepared") throw new Error("NO_MORNING");
  const claim = loop.claim(prepared.run_id);
  if (state === "uncertain") loop.markUncertain(claim, "EXECUTION_OUTCOME_UNCERTAIN");
  db.close();
  const now = state === "expired" ? new Date("2026-08-27T22:35:00.000Z") : at;
  const code = state === "active" ? "DAILY_LOOP_LEASE_ACTIVE" : state === "uncertain"
    ? "DAILY_LOOP_OUTCOME_UNCERTAIN" : "DAILY_LOOP_DEADLINE_EXHAUSTED";
  await expect(execute(f.args, { clock: () => now })).rejects.toMatchObject({ code });
});

it("does not relabel the completed cycle when midnight arrives during the response", async () => {
  const f = await fixture(); await execute(f.args, { clock: () => at });
  const times = ["2026-08-28T14:59:59.999Z", "2026-08-28T14:59:59.999Z", "2026-08-28T15:00:00.000Z"];
  await expect(execute(f.args, { clock: () => new Date(times.shift() ?? "2026-08-28T15:00:00.000Z") }))
    .rejects.toMatchObject({ code: "DAILY_LOOP_STALE_LEASE" });
});

it("does not report a completion before its persisted completion time after clock rollback", async () => {
  const f = await fixture(); let tick = 0;
  await execute(f.args, { clock: () => new Date(at.getTime() + tick++) });
  const saved = rows(f.path);
  const run = saved.runs.find(row => (row as Record<string, unknown>).state === "completed") as Record<string, string>;
  const step = saved.steps.find(row => (row as Record<string, unknown>).step_key === "morning_reconcile"
    && (row as Record<string, unknown>).state === "completed") as Record<string, string>;
  const generated = JSON.parse(step.detail_json!).generated_at as string;
  expect(run.updated_at! > generated).toBe(true);
  await expect(execute(f.args, { clock: () => new Date(generated) }))
    .rejects.toMatchObject({ code: "DAILY_LOOP_STALE_LEASE" });
});


it("rejects duplicate daily budget fields without preparing work", async () => {
  const f = await fixture(); const before = rows(f.path);
  const text = JSON.stringify(config).replace('"max_work":', '"max_work":0,"max_work":');
  writeFileSync(f.input, text);
  await expect(execute(f.args, { clock: () => at })).rejects.toMatchObject({ code: "DAILY_LOOP_CONFIG_INVALID" });
  expect(rows(f.path)).toEqual(before);
});
