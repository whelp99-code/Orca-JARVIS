import { spawnSync } from "node:child_process";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { afterEach, expect, it } from "vitest";
import { AuthorityDb } from "../../src/db.js";
import { todayProjection } from "../../src/dashboard/personal-today.js";
import { localObservationChain } from "../fixtures/local-observation-chain.js";
import { tempDb } from "../helpers.js";

// Two morning instants on the same local date, and the local times they are. config/personal-os-
// policy.json is effective from 2026-08-28T00:00:00.000Z, so both are inside the policy's life.
const SHIPPED_MORNING = { at: "2026-08-29T22:15:00.000Z", local: "07:15" };
const MOVED_MORNING = { at: "2026-08-29T00:40:00.000Z", local: "09:40" };
const RECEIPT_PATH = "/nonexistent/second-brain-refresh-receipt.json";
const BINARY = resolve(process.cwd(), "dist/src/cli.js");
// The product binary exposes no clock override and must not gain one, so the fixed-instant runs go
// through the same compiled build via the test-only entry that injects the clock.
const HARNESS = resolve(process.cwd(), "dist/tests/fixtures/compiled-daily-cli.js");

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

const BASE = { time_zone: "Asia/Seoul", lease_ms: 300_000, deadline_ms: 600_000,
  recovery_window_ms: 600_000, recovery_lookback_days: 2, refresh_freshness_ms: 600_000,
  budgets: { max_items: 8, max_work: 8, max_bytes: 8192 } } as const;

async function fixture(at: string) {
  expect(existsSync(HARNESS), "dist/tests/fixtures is required; run npm run build:backend").toBe(true);
  const path = tempDb();
  const root = dirname(path);
  roots.push(root);
  const db = new AuthorityDb(path);
  const chain = await localObservationChain(db, at);
  db.close();
  return { path, root, chain };
}

function configFile(root: string, name: string, value: unknown): string {
  const path = join(root, name);
  writeFileSync(path, JSON.stringify(value));
  return path;
}

const child = (args: readonly string[]) => {
  const result = spawnSync(process.execPath, [...args], { encoding: "utf8" });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
};

function published(path: string, at: string) {
  const db = new AuthorityDb(path);
  try {
    return { brief: todayProjection(db, new Date(at))["brief"] as { state: string; item_count: number },
      completed: Number(db.db.prepare(
        "SELECT COUNT(*) FROM daily_loop_runs WHERE phase='morning' AND state='completed'").pluck().get()) };
  } finally { db.close(); }
}

const clockAt = (at: string): string => new Date(Date.parse(at) + 5).toISOString();

it("honours a v3 morning_local_time the deployment configured", async () => {
  const f = await fixture(MOVED_MORNING.at);
  const input = configFile(f.root, "daily-v3.json", { schema_version: 3, ...BASE,
    refresh_receipt_path: RECEIPT_PATH, morning_local_time: MOVED_MORNING.local });

  const run = child([HARNESS, f.path, input, clockAt(MOVED_MORNING.at)]);

  expect(run.stderr).toBe("");
  expect(run.status).toBe(0);
  expect(JSON.parse(run.stdout)).toMatchObject({ version: 1, ok: true, command: "daily.morning",
    run: { state: "completed" } });
  const after = published(f.path, clockAt(MOVED_MORNING.at));
  expect(after.brief).toMatchObject({ state: "ready", item_count: 1 });
  expect(after.completed).toBe(1);
});

it("leaves the shipped 07:15 instant not due once the morning is configured elsewhere", async () => {
  const f = await fixture(SHIPPED_MORNING.at);
  const input = configFile(f.root, "daily-v3.json", { schema_version: 3, ...BASE,
    refresh_receipt_path: RECEIPT_PATH, morning_local_time: MOVED_MORNING.local });

  const run = child([HARNESS, f.path, input, clockAt(SHIPPED_MORNING.at)]);

  expect(run.status).toBe(0);
  expect(JSON.parse(run.stdout)).toMatchObject({ ok: true, run: null, brief: null });
  expect(published(f.path, clockAt(SHIPPED_MORNING.at)).completed).toBe(0);
});

it("keeps the shipped schedule for a v3 configuration that names it explicitly", async () => {
  const f = await fixture(SHIPPED_MORNING.at);
  const input = configFile(f.root, "daily-v3.json", { schema_version: 3, ...BASE,
    refresh_receipt_path: RECEIPT_PATH, morning_local_time: SHIPPED_MORNING.local });

  const run = child([HARNESS, f.path, input, clockAt(SHIPPED_MORNING.at)]);

  expect(run.status).toBe(0);
  expect(JSON.parse(run.stdout)).toMatchObject({ ok: true, run: { state: "completed" } });
  expect(published(f.path, clockAt(SHIPPED_MORNING.at)).completed).toBe(1);
});

it.each([
  ["v1", { schema_version: 1, ...BASE }],
  ["v2", { schema_version: 2, ...BASE, refresh_receipt_path: RECEIPT_PATH }],
])("keeps %s on the shipped 07:15 schedule", async (_name, value) => {
  const f = await fixture(SHIPPED_MORNING.at);
  const input = configFile(f.root, "daily.json", value);

  const run = child([HARNESS, f.path, input, clockAt(SHIPPED_MORNING.at)]);

  expect(run.status).toBe(0);
  expect(JSON.parse(run.stdout)).toMatchObject({ ok: true, run: { state: "completed" } });
  expect(published(f.path, clockAt(SHIPPED_MORNING.at)).completed).toBe(1);
});

it.each([
  ["a time outside the day", "24:00"],
  ["an unpadded hour", "7:15"],
  ["seconds", "09:40:00"],
  ["the evening phase's own time", "21:30"],
  ["not a string", 715],
  ["absent", undefined],
])("refuses a v3 configuration whose morning time is %s", async (_name, local) => {
  const f = await fixture(MOVED_MORNING.at);
  const input = configFile(f.root, "daily-bad.json", { schema_version: 3, ...BASE,
    refresh_receipt_path: RECEIPT_PATH, ...(local === undefined ? {} : { morning_local_time: local }) });

  const run = child([BINARY, "daily", "morning", "--once", "--db", f.path, "--input", input]);

  expect(run.status).toBe(2);
  expect(run.stdout).toBe("");
  expect(JSON.parse(run.stderr)).toMatchObject({ ok: false, error: { code: "DAILY_LOOP_CONFIG_INVALID" } });
  expect(published(f.path, clockAt(MOVED_MORNING.at)).completed).toBe(0);
});

it.each([
  ["v1", 1],
  ["v2", 2],
])("refuses a %s configuration that names a morning time its version has no field for", async (_name, version) => {
  const f = await fixture(MOVED_MORNING.at);
  const input = configFile(f.root, "daily-early.json", { schema_version: version, ...BASE,
    ...(version === 2 ? { refresh_receipt_path: RECEIPT_PATH } : {}),
    morning_local_time: MOVED_MORNING.local });

  const run = child([BINARY, "daily", "morning", "--once", "--db", f.path, "--input", input]);

  expect(run.status).toBe(2);
  expect(JSON.parse(run.stderr)).toMatchObject({ ok: false, error: { code: "DAILY_LOOP_CONFIG_INVALID" } });
});
