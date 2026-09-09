import { rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { DailyControlLoop } from "../../src/daily-loop-service.js";
import { DailyLoopError } from "../../src/daily-loop-types.js";
import { DailyServiceCycles } from "../../src/daily-service-cycles.js";
import { generateKeyPairSync } from "node:crypto";
import { dirname, join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { execute } from "../../src/cli.js";
import { AuthorityDb } from "../../src/db.js";
import { tempDb } from "../helpers.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
async function fixture() {
  const path = tempDb(); const root = dirname(path); roots.push(root);
  const keys = generateKeyPairSync("ed25519"); const key = join(root, "evening.pem");
  writeFileSync(key, keys.privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
  const config = { schema_version: 1, daily: { time_zone: "Asia/Seoul", lease_ms: 30000, deadline_ms: 60000,
    recovery_window_ms: 60000, recovery_lookback_days: 2, refresh_freshness_ms: 60000,
    budgets: { max_items: 10, max_work: 10, max_bytes: 1048576 } },
  source: { repository_identities: [], max_records: 10, max_bytes: 1048576 },
  trusted_key: { key_id: "native-cli", public_key_spki: keys.publicKey.export({ type: "spki", format: "der" }).toString("base64url") } };
  const input = join(root, "daily.json"); writeFileSync(input, JSON.stringify(config));
  const db = new AuthorityDb(path); await db.migrate(); db.close();
  return { path, root, key, input, config, args: ["service", "run", "--once", "--db", path, "--input", input, "--key-file", key] };
}

it("runs configured daily executors with a disconnected coordinator and deduplicates repeated service startup", async () => {
  const f = await fixture();
  const morning = new Date("2026-08-30T22:15:00.005Z");
  const first = await execute(f.args, { clock: () => morning });
  expect(first).toMatchObject({ ok: true, state: "disconnected", daily: { provider_refresh: "unavailable",
    phases: { morning: { status: "processed" }, evening: { status: "processed" } } } });
  const replay = await execute(f.args, { clock: () => morning });
  expect(replay).toMatchObject({ daily: { phases: { morning: { result: { completed_run_ids: [] } } } } });
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import { execute } from './dist/src/cli.js';
    console.log(JSON.stringify(await execute(JSON.parse(process.argv[1]), { clock: () => new Date(process.argv[2]) })));
  `, JSON.stringify(f.args), "2026-08-31T12:30:00.005Z"], { encoding: "utf8", timeout: 10000 });
  expect(child.status, child.stderr).toBe(0);
  const evening = JSON.parse(child.stdout);
  expect(evening).toMatchObject({ daily: { phases: { evening: { status: "processed" } } } });
  const db = new AuthorityDb(f.path);
  try {
    const rows = db.db.prepare("SELECT phase,state FROM daily_loop_runs WHERE loop_date='2026-08-31' ORDER BY phase").all();
    expect(rows).toEqual([{ phase: "evening", state: "completed" }, { phase: "morning", state: "completed" }]);
    expect(db.db.prepare("SELECT COUNT(*) n FROM native_evening_publications").get()).toEqual({ n: 1 });
  } finally { db.close(); }
});

it("rejects incomplete configuration before preparing daily runs", async () => {
  const f = await fixture();
  await expect(execute(f.args.slice(0, -2))).rejects.toMatchObject({ code: "DAILY_LOOP_CONFIG_INVALID" });
  const db = new AuthorityDb(f.path);
  try { expect(db.db.prepare("SELECT COUNT(*) n FROM daily_loop_runs").get()).toEqual({ n: 0 }); }
  finally { db.close(); }
});

it("continues evening publication after a morning executor error", async () => {
  const f = await fixture();
  const fail = vi.spyOn(DailyControlLoop.prototype, "startup").mockImplementationOnce(async () => {
    throw new DailyLoopError("DAILY_LOOP_STALE_LEASE");
  });
  try {
    const result = await execute(f.args, { clock: () => new Date("2026-08-31T12:30:00.005Z") });
    expect(result).toMatchObject({ daily: { phases: {
      morning: { status: "error", code: "DAILY_LOOP_STALE_LEASE" }, evening: { status: "processed" },
    } } });
    const db = new AuthorityDb(f.path);
    try { expect(db.db.prepare("SELECT COUNT(*) n FROM native_evening_publications").get()).toEqual({ n: 1 }); }
    finally { db.close(); }
  } finally { fail.mockRestore(); }
});

it("rejects overlapping cycles and advances from morning to evening without duplicate publication", async () => {
  const f = await fixture(); const db = new AuthorityDb(f.path);
  let at = new Date("2026-08-30T22:15:00.005Z");
  try {
    const daily = await DailyServiceCycles.fromFiles(db, f.input, f.key, () => at);
    const first = daily.cycle();
    await expect(daily.cycle()).rejects.toMatchObject({ code: "DAILY_LOOP_SERVICE_BUSY" });
    await first;
    at = new Date("2026-08-31T12:30:00.005Z");
    expect((await daily.cycle()).evening.status).toBe("processed");
    await daily.cycle();
    expect(db.db.prepare("SELECT COUNT(*) n FROM native_evening_publications").get()).toEqual({ n: 1 });
  } finally { db.close(); }
});

it("rejects daily configuration on the staged control channel without preparing runs", async () => {
  const f = await fixture();
  vi.stubEnv("PERSONAL_OS_CONTROL_CHANNEL", "/unused/daily-service-test.sock");
  try {
    await expect(execute(f.args)).rejects.toMatchObject({ code: "DAILY_LOOP_CONFIG_INVALID" });
    const db = new AuthorityDb(f.path);
    try { expect(db.db.prepare("SELECT COUNT(*) n FROM daily_loop_runs").get()).toEqual({ n: 0 }); }
    finally { db.close(); }
  } finally { vi.unstubAllEnvs(); }
});

it("records missed recovery instead of publishing an overdue morning artifact", async () => {
  const f = await fixture();
  const result = await execute(f.args, { clock: () => new Date("2026-08-31T00:00:00.000Z") });
  expect(result).toMatchObject({ daily: { phases: { morning: { result: { completed_run_ids: [] } } } } });
  const db = new AuthorityDb(f.path);
  try {
    expect(db.db.prepare("SELECT state,failure_code FROM daily_loop_runs WHERE loop_date='2026-08-31' AND phase='morning'").get())
      .toMatchObject({ state: "failed", failure_code: "MISSED_RECOVERY_WINDOW" });
  } finally { db.close(); }
});
