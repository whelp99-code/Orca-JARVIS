import { rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { AuthorityDb } from "../../src/db.js";
import { execute } from "../../src/cli.js";
import { todayProjection } from "../../src/dashboard/personal-today.js";
import { LocalTimelineSnapshotStore } from "../../src/local-timeline-snapshot-store.js";
import { localObservationChain, LOCAL_CHAIN_TASK_ID } from "../fixtures/local-observation-chain.js";
import { tempDb } from "../helpers.js";

// The morning schedule fires only at 07:15:00.000 KST (src/daily-loop-time.ts), so the chain is
// placed exactly there; the time-parameterised fixture is what makes that possible. The date is
// 08-29 rather than 08-28 because config/personal-os-policy.json is effective_at
// 2026-08-28T00:00:00.000Z, and the 08-28 morning falls at 2026-08-27T22:15Z, before it. Ranking
// at that earlier instant abstains with POLICY_NOT_EFFECTIVE.
const MORNING_KST_0715 = "2026-08-28T22:15:00.000Z";
const CLI_AT = new Date("2026-08-28T22:15:00.005Z");

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

async function fixture() {
  const path = tempDb();
  const root = dirname(path);
  roots.push(root);
  const input = join(root, "daily.json");
  writeFileSync(input, JSON.stringify({ schema_version: 1, time_zone: "Asia/Seoul", lease_ms: 300_000,
    deadline_ms: 600_000, recovery_window_ms: 600_000, recovery_lookback_days: 2,
    refresh_freshness_ms: 600_000, budgets: { max_items: 8, max_work: 8, max_bytes: 8192 } }));
  const db = new AuthorityDb(path);
  const chain = await localObservationChain(db, MORNING_KST_0715);
  db.close();
  return { path, input, chain, args: ["daily", "morning", "--once", "--db", path, "--input", input] };
}

function reopen(path: string) {
  const db = new AuthorityDb(path);
  try {
    return { brief: todayProjection(db, CLI_AT)["brief"] as { state: string; item_count: number; brief_id: string | null },
      detail: String(db.db.prepare(
        `SELECT detail_json FROM daily_loop_steps WHERE step_key='morning_reconcile' AND state='completed'
         ORDER BY updated_at DESC LIMIT 1`).pluck().get()),
      runs: Number(db.db.prepare("SELECT COUNT(*) FROM daily_loop_runs").pluck().get()),
      completedRuns: Number(db.db.prepare(
        "SELECT COUNT(*) FROM daily_loop_runs WHERE state='completed'").pluck().get()),
      reconciles: Number(db.db.prepare(
        "SELECT COUNT(*) FROM daily_loop_steps WHERE step_key='morning_reconcile' AND state='completed'")
        .pluck().get()) };
  } finally { db.close(); }
}

it("publishes the local observation chain through the real daily morning CLI handler", async () => {
  const f = await fixture();
  const result = await execute(f.args, { clock: () => CLI_AT });
  expect(result).toMatchObject({ ok: true, command: "daily.morning",
    provider_refresh: "unavailable", automatic_operation: "hold", run: { state: "completed" } });
  expect(result.completed_run_ids).toHaveLength(1);

  const after = reopen(f.path);
  // The brief the CLI published carries the item whose current evidence is the local observation.
  expect(after.brief).toMatchObject({ state: "ready", item_count: 1 });
  expect(after.brief.brief_id).toMatch(/^morning-brief:v2:[0-9a-f]{64}$/);
  expect(after.detail).toContain(f.chain.created.recommendation.id);
  expect(after.reconciles).toBe(1);
  expect(JSON.parse(after.detail)["context_readiness"]).not.toBe("no_data");
});

it("replays the same CLI invocation without publishing a second brief", async () => {
  const f = await fixture();
  await execute(f.args, { clock: () => CLI_AT });
  const first = reopen(f.path);
  const replay = await execute(f.args, { clock: () => new Date(CLI_AT.getTime() + 1000) });
  expect(replay.completed_run_ids).toEqual([]);
  const second = reopen(f.path);
  expect(second.runs).toBe(first.runs); expect(second.completedRuns).toBe(first.completedRuns);
  expect(second.reconciles).toBe(1);
  expect(second.brief.brief_id).toBe(first.brief.brief_id);
});

it("publishes an abstaining brief when the local source is held before the CLI runs", async () => {
  const f = await fixture();
  const db = new AuthorityDb(f.path);
  try { new LocalTimelineSnapshotStore(db, () => CLI_AT).setHeld(LOCAL_CHAIN_TASK_ID, true); }
  finally { db.close(); }
  const result = await execute(f.args, { clock: () => CLI_AT });
  expect(result).toMatchObject({ ok: true, run: { state: "completed" } });
  const after = reopen(f.path);
  expect(after.brief.item_count).toBe(0);
  expect(after.detail).not.toContain(f.chain.created.recommendation.id);
  expect(JSON.parse(after.detail)["abstention_reasons"]).toEqual(["no_authoritative_data"]);
  expect(after.reconciles).toBe(1);
});
