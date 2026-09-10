import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { afterEach, expect, it } from "vitest";
import { AuthorityDb } from "../../src/db.js";
import { todayProjection } from "../../src/dashboard/personal-today.js";
import { LocalTimelineSnapshotStore } from "../../src/local-timeline-snapshot-store.js";
import { localObservationChain, LOCAL_CHAIN_TASK_ID } from "../fixtures/local-observation-chain.js";
import { tempDb } from "../helpers.js";

// Same instants as the in-process daily CLI test: the morning schedule fires only at
// 07:15:00.000 KST and config/personal-os-policy.json is effective from 2026-08-28T00:00:00.000Z.
const MORNING_KST_0715 = "2026-08-28T22:15:00.000Z";
const CLI_AT = "2026-08-28T22:15:00.005Z";
const BINARY = resolve(process.cwd(), "dist/src/cli.js");
// The product binary exposes no clock override and must not gain one, so the fixed-instant cases
// run the same compiled build through a test-only entry that injects the clock. Both are real
// child processes with their own argv, stdout, stderr and exit code.
const HARNESS = resolve(process.cwd(), "dist/tests/fixtures/compiled-daily-cli.js");

const opened: AuthorityDb[] = [];
const roots: string[] = [];
afterEach(() => {
  for (const db of opened.splice(0)) if (db.db.open) db.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const sha = (path: string): string => createHash("sha256").update(readFileSync(path)).digest("hex");
const child = (args: readonly string[]) => {
  const result = spawnSync(process.execPath, [...args], { encoding: "utf8" });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
};

async function fixture() {
  expect(existsSync(BINARY), "dist/src/cli.js is required; run npm run build:backend").toBe(true);
  expect(existsSync(HARNESS), "dist/tests/fixtures is required; run npm run build:backend").toBe(true);
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
  return { path, input, root, chain };
}

/** Reads the result the exited process left behind, through a connection it never shared. */
function reopen(path: string) {
  const db = new AuthorityDb(path);
  try {
    return {
      brief: todayProjection(db, new Date(CLI_AT))["brief"] as
        { state: string; item_count: number; brief_id: string | null },
      detail: String(db.db.prepare(
        `SELECT detail_json FROM daily_loop_steps WHERE step_key='morning_reconcile' AND state='completed'
         ORDER BY updated_at DESC LIMIT 1`).pluck().get()),
      runs: Number(db.db.prepare("SELECT COUNT(*) FROM daily_loop_runs").pluck().get()),
      reconciles: Number(db.db.prepare(
        "SELECT COUNT(*) FROM daily_loop_steps WHERE step_key='morning_reconcile' AND state='completed'")
        .pluck().get()),
    };
  } finally { db.close(); }
}

it("fails closed through the real compiled binary and leaves the database untouched", async () => {
  const f = await fixture();
  const unusable = join(f.root, "unusable-daily.json");
  writeFileSync(unusable, JSON.stringify({ schema_version: 2 }));
  const before = sha(f.path);

  const run = child([BINARY, "daily", "morning", "--once", "--db", f.path, "--input", unusable]);

  expect(run.status).toBe(2);
  expect(run.stdout).toBe("");
  expect(JSON.parse(run.stderr)).toMatchObject({ version: 1, ok: false,
    error: { code: "DAILY_LOOP_CONFIG_INVALID" } });
  expect(sha(f.path)).toBe(before);
  const after = reopen(f.path);
  expect(after.runs).toBe(0);
});

it("publishes and then replays the chain through a real compiled child process", async () => {
  const f = await fixture();

  const first = child([HARNESS, f.path, f.input, CLI_AT]);
  expect(first.stderr).toBe("");
  expect(first.status).toBe(0);
  expect(JSON.parse(first.stdout)).toMatchObject({ version: 1, ok: true, command: "daily.morning",
    provider_refresh: "unavailable", automatic_operation: "hold", run: { state: "completed" } });
  expect(JSON.parse(first.stdout).completed_run_ids).toHaveLength(1);

  // Everything below is read after that process exited, through a new connection.
  const published = reopen(f.path);
  expect(published.brief).toMatchObject({ state: "ready", item_count: 1 });
  expect(published.brief.brief_id).toMatch(/^morning-brief:v2:[0-9a-f]{64}$/);
  expect(published.detail).toContain(f.chain.created.recommendation.id);
  expect(published.reconciles).toBe(1);

  const replay = child([HARNESS, f.path, f.input, "2026-08-28T22:15:01.005Z"]);
  expect(replay.status).toBe(0);
  expect(JSON.parse(replay.stdout).completed_run_ids).toEqual([]);
  const second = reopen(f.path);
  expect(second.runs).toBe(published.runs);
  expect(second.reconciles).toBe(1);
  expect(second.brief.brief_id).toBe(published.brief.brief_id);
});

it("publishes an abstaining brief from the child process when the local source is held", async () => {
  const f = await fixture();
  const db = new AuthorityDb(f.path);
  try { new LocalTimelineSnapshotStore(db, () => new Date(CLI_AT)).setHeld(LOCAL_CHAIN_TASK_ID, true); }
  finally { db.close(); }

  const run = child([HARNESS, f.path, f.input, CLI_AT]);

  expect(run.status).toBe(0);
  expect(JSON.parse(run.stdout)).toMatchObject({ ok: true, run: { state: "completed" } });
  const after = reopen(f.path);
  expect(after.brief.item_count).toBe(0);
  expect(after.detail).not.toContain(f.chain.created.recommendation.id);
  expect(JSON.parse(after.detail)["abstention_reasons"]).toEqual(["no_authoritative_data"]);
  expect(after.reconciles).toBe(1);
});
