import { rmSync, writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { DailyControlLoop } from "../../src/daily-loop-service.js";
import { DailyLoopError } from "../../src/daily-loop-types.js";
import { DailyServiceCycles } from "../../src/daily-service-cycles.js";
import { generateKeyPairSync } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { execute } from "../../src/cli.js";
import { AuthorityDb } from "../../src/db.js";
import { todayProjection } from "../../src/dashboard/personal-today.js";
import { ABSENT_PROVIDER_ROOTS, CLI_AT, dailyProductionChild,
  prepareDailyProductionChain } from "../fixtures/daily-production-chain.js";
import { closeMemoryDatabase, type MemoryDatabase } from "../fixtures/memory-candidate-store.js";
import { tempDb } from "../helpers.js";

const roots: string[] = [];
const chains: MemoryDatabase[] = [];
// The morning policy resolves the deployed endpoint from the configured provider roots, so an
// in-process run says "no provider" by pointing those roots at an installation that does not exist.
beforeEach(() => {
  for (const [name, value] of Object.entries(ABSENT_PROVIDER_ROOTS)) vi.stubEnv(name, value);
});
afterEach(() => {
  vi.unstubAllEnvs();
  for (const database of chains.splice(0)) closeMemoryDatabase(database);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
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

// §7.3's configured service, over a database holding exactly what one real recommendation needs.
//
// The same production chain the compiled `daily morning` regression uses, so a difference between
// the two surfaces is a difference in the product and not in two fixtures. The service inserts no
// recommendation: the chain asserts zero rows before the run, and what the brief publishes here is
// the row the run itself produced.
const MORNING_DATE = "2026-08-29";

async function productionService() {
  const chain = await prepareDailyProductionChain({ ownerDecision: "confirm", ownerAuthorization: true });
  chains.push(chain.database);
  const root = dirname(chain.path);
  const keys = generateKeyPairSync("ed25519");
  const key = join(root, "service.pem");
  writeFileSync(key, keys.privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
  // The same daily windows the compiled-CLI production regression configures, so the fixed instant
  // that satisfies the 07:15 KST schedule and the policy's effective_at satisfies both surfaces.
  const input = join(root, "service.json");
  writeFileSync(input, JSON.stringify({ schema_version: 1,
    daily: { time_zone: "Asia/Seoul", lease_ms: 300_000, deadline_ms: 600_000,
      recovery_window_ms: 600_000, recovery_lookback_days: 2, refresh_freshness_ms: 600_000,
      budgets: { max_items: 8, max_work: 8, max_bytes: 8192 } },
    source: { repository_identities: [], max_records: 10, max_bytes: 1_048_576 },
    trusted_key: { key_id: "native-cli",
      public_key_spki: keys.publicKey.export({ type: "spki", format: "der" }).toString("base64url") } }));
  return { ...chain, key, input,
    args: ["service", "once", "--db", chain.path, "--input", input, "--key-file", key] };
}

/** `service once` through the compiled build in its own process, with its own argv and exit code. */
const serviceChild = (args: readonly string[], at: string, environment: Readonly<Record<string, string>> = {}) =>
  dailyProductionChild(["--input-type=module", "-e",
    `import { execute } from ${JSON.stringify(pathToFileURL(resolve("dist/src/cli.js")).href)};
     process.stdout.write(JSON.stringify(await execute(JSON.parse(process.argv[1]),
       { clock: () => new Date(process.argv[2]) })));`,
    JSON.stringify(args), at], environment);

const produced = (path: string, at: string, date: string) => {
  const db = new AuthorityDb(path);
  try {
    return {
      rows: db.db.prepare("SELECT recommendation_id FROM personal_recommendations").pluck().all() as string[],
      brief: todayProjection(db, new Date(at))["brief"] as { state: string; item_count: number },
      detail: String(db.db.prepare(
        `SELECT detail_json FROM daily_loop_steps WHERE step_key='morning_reconcile' AND state='completed'
         ORDER BY updated_at DESC LIMIT 1`).pluck().get()),
      phases: db.db.prepare(
        "SELECT phase,state FROM daily_loop_runs WHERE loop_date=? ORDER BY phase").all(date),
      evening: Number(db.db.prepare("SELECT COUNT(*) FROM native_evening_publications").pluck().get()),
      reconciles: Number(db.db.prepare(
        "SELECT COUNT(*) FROM daily_loop_steps WHERE step_key='morning_reconcile' AND state='completed'")
        .pluck().get()),
    };
  } finally { db.close(); }
};

it("produces one recommendation through the compiled service and publishes it in the morning brief", async () => {
  const f = await productionService();

  const run = serviceChild(f.args, CLI_AT, f.provider);

  expect(run.stderr).toBe("");
  expect(run.status).toBe(0);
  expect(JSON.parse(run.stdout)).toMatchObject({ ok: true, command: "service.once",
    daily: { scope: "stored-local-sources", phases: { morning: { status: "processed" },
      evening: { status: "processed" } } } });
  const after = produced(f.path, CLI_AT, MORNING_DATE);
  // 0 -> 1: the chain asserted the empty table, and this is the row the service's own run made.
  expect(after.rows).toHaveLength(1);
  expect(after.brief).toMatchObject({ state: "ready", item_count: 1 });
  // The published brief carries that row, not a fixture's.
  expect(after.detail).toContain(after.rows[0]);
  // Both phases ran, morning first, and only the morning was due at 07:15 KST: the evening phase
  // processed its cycle without opening a run or publishing a closeout for this local date.
  expect(after.phases).toEqual([{ phase: "morning", state: "completed" }]);
  expect(after.evening).toBe(0);
}, 120_000);

// Same database, same service, no provider named. Producing is what stops; the service does not.
it("completes the service cycle with no recommendation when the deployment names no provider", async () => {
  const f = await productionService();

  const run = serviceChild(f.args, CLI_AT);

  expect(run.stderr).toBe("");
  expect(run.status).toBe(0);
  expect(JSON.parse(run.stdout)).toMatchObject({ ok: true, command: "service.once",
    daily: { phases: { morning: { status: "processed" }, evening: { status: "processed" } } } });
  const after = produced(f.path, CLI_AT, MORNING_DATE);
  expect(after.rows).toEqual([]);
  expect(after.brief).toMatchObject({ item_count: 0 });
  expect(after.phases).toEqual([{ phase: "morning", state: "completed" }]);
  expect(after.evening).toBe(0);
}, 120_000);

// Failure isolation with production plumbed in: a morning that fails still leaves the evening to
// publish, and a failed morning writes no recommendation.
it("continues evening publication when the producing morning executor fails", async () => {
  const f = await productionService();
  const fail = vi.spyOn(DailyControlLoop.prototype, "startup").mockImplementationOnce(async () => {
    throw new DailyLoopError("DAILY_LOOP_STALE_LEASE");
  });
  try {
    const db = new AuthorityDb(f.path);
    try {
      const daily = await DailyServiceCycles.fromFiles(db, f.input, f.key, () => new Date(CLI_AT));
      expect(await daily.cycle()).toMatchObject({ morning: { status: "error", code: "DAILY_LOOP_STALE_LEASE" },
        evening: { status: "processed" } });
      // Nothing produced, because the step that produces never ran; the evening phase still did.
      expect(db.db.prepare("SELECT COUNT(*) FROM personal_recommendations").pluck().get()).toBe(0);
    } finally { db.close(); }
  } finally { fail.mockRestore(); }
}, 120_000);

/** The same compiled `service once`, started concurrently, so the two really do compete. */
const serviceRace = (args: readonly string[], at: string, environment: Readonly<Record<string, string>>) =>
  new Promise<{ status: number | null; stdout: string; stderr: string }>(done => {
    const inherited = { ...process.env };
    delete inherited["JARVIS_SECOND_BRAIN_LAUNCHER"];
    delete inherited["JARVIS_SECOND_BRAIN_CONFIG"];
    const process_ = spawn(process.execPath, ["--input-type=module", "-e",
      `import { execute } from ${JSON.stringify(pathToFileURL(resolve("dist/src/cli.js")).href)};
       process.stdout.write(JSON.stringify(await execute(JSON.parse(process.argv[1]),
         { clock: () => new Date(process.argv[2]) })));`,
      JSON.stringify(args), at], { env: { ...inherited, ...environment } });
    let stdout = ""; let stderr = "";
    process_.stdout.setEncoding("utf8"); process_.stderr.setEncoding("utf8");
    process_.stdout.on("data", chunk => { stdout += chunk; });
    process_.stderr.on("data", chunk => { stderr += chunk; });
    process_.on("close", status => done({ status, stdout, stderr }));
  });

// §7.3: two competing services. Both are started for the same morning against the same database at
// the same instant, and the lease decides. Whichever wins, the day has exactly one recommendation
// and one reconcile, and the published brief carries the row that was actually produced.
it("lets two competing services produce exactly one recommendation for the morning", async () => {
  const f = await productionService();

  const [first, second] = await Promise.all([
    serviceRace(f.args, CLI_AT, f.provider), serviceRace(f.args, CLI_AT, f.provider)]);

  // A loser reports a lease failure; neither may crash.
  for (const run of [first, second]) expect([0, 2]).toContain(run.status);
  expect([first.status, second.status]).toContain(0);
  const after = produced(f.path, CLI_AT, MORNING_DATE);
  expect(after.rows).toHaveLength(1);
  expect(after.brief).toMatchObject({ state: "ready", item_count: 1 });
  expect(after.detail).toContain(after.rows[0]);
  expect(after.reconciles).toBe(1);
  expect(after.phases).toEqual([{ phase: "morning", state: "completed" }]);
}, 180_000);
