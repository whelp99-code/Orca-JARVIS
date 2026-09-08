import { chmodSync, existsSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { generateKeyPairSync } from "node:crypto";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { execute } from "../../src/cli.js";
import { AuthorityDb } from "../../src/db.js";
import { tempDb } from "../helpers.js";
import { MemoryProjectionAuthority } from "../../src/memory-projection-authority.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const at = new Date("2026-08-30T12:30:00.005Z");
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
  return { path, root, key, input, config, args: ["daily", "evening", "--once", "--db", path, "--input", input, "--key-file", key] };
}
function snapshot(path: string) {
  const db = new AuthorityDb(path);
  try { return { runs: db.db.prepare("SELECT * FROM daily_loop_runs ORDER BY run_id").all(),
    steps: db.db.prepare("SELECT * FROM daily_loop_steps ORDER BY step_id").all(),
    publications: db.db.prepare("SELECT * FROM native_evening_publications").all() }; }
  finally { db.close(); }
}

it("publishes through CLI and replays through a separate compiled process without changing the ledger", async () => {
  const f = await fixture();
  const first = await execute(f.args, { clock: () => at });
  expect(first).toMatchObject({ ok: true, command: "daily.evening", automatic_operation: "hold",
    run: { state: "completed" }, report: { native_completion_count: 0, source_readiness: "degraded" }, usage: { items: 0, work: 1 } });
  const saved = snapshot(f.path);
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import { execute } from './dist/src/cli.js';
    console.log(JSON.stringify(await execute(JSON.parse(process.argv[1]), { clock: () => new Date(process.argv[2]) })));
  `, JSON.stringify(f.args), at.toISOString()], { encoding: "utf8", timeout: 10000 });
  expect(child.status, child.stderr).toBe(0);
  const replay = JSON.parse(child.stdout);
  expect(replay.completed_run_ids).toEqual([]); expect(replay.report).toEqual(first.report);
  expect(snapshot(f.path)).toEqual(saved);
});

it.each(["permissions", "symlink", "wrong-key", "oversized-key", "config", "oversized-config"] as const)(
  "rejects %s before preparing daily work", async mode => {
    const f = await fixture(); const before = snapshot(f.path);
    if (mode === "permissions") chmodSync(f.key, 0o644);
    if (mode === "symlink") { const original = join(f.root, "original.pem");
      writeFileSync(original, "private fixture", { mode: 0o600 }); rmSync(f.key); symlinkSync(original, f.key); }
    if (mode === "wrong-key") writeFileSync(f.key, generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }));
    if (mode === "oversized-key") writeFileSync(f.key, "x".repeat(4097));
    if (mode === "config") writeFileSync(f.input, JSON.stringify({ ...f.config, extra: "not allowed" }));
    if (mode === "oversized-config") writeFileSync(f.input, " ".repeat(16385));
    await expect(execute(f.args, { clock: () => at })).rejects.toMatchObject({ code: "DAILY_LOOP_CONFIG_INVALID" });
    expect(snapshot(f.path)).toEqual(before);
  });

it("rejects missing key flag before opening the database", async () => {
  const path = tempDb(); roots.push(dirname(path));
  await expect(execute(["daily", "evening", "--once", "--db", path, "--input", "missing"]))
    .rejects.toMatchObject({ code: "DAILY_LOOP_CONFIG_INVALID" });
  expect(existsSync(path)).toBe(false);
});

it("reports budget failure without returning CLI success", async () => {
  const f = await fixture(); f.config.daily.budgets.max_bytes = 1; writeFileSync(f.input, JSON.stringify(f.config));
  await expect(execute(f.args, { clock: () => at })).rejects.toMatchObject({ code: "DAILY_LOOP_BUDGET_BYTES_EXHAUSTED" });
  expect(snapshot(f.path).publications).toEqual([]);
});

it("does not expose a quarantined completed report on replay", async () => {
  const f = await fixture(); await execute(f.args, { clock: () => at }); const db = new AuthorityDb(f.path);
  const row = db.db.prepare("SELECT run_id FROM native_evening_publications").get() as { run_id: string };
  new MemoryProjectionAuthority(db).quarantineUnresolved({ kind: "daily_run", id: row.run_id, component_id: row.run_id }, at);
  db.close();
  await expect(execute(f.args, { clock: () => at })).rejects.toMatchObject({ code: "DAILY_LOOP_RESULT_UNAVAILABLE" });
});

it("replays morning after evening with the configured verification key and whole-day usage", async () => {
  const f = await fixture(); const morningInput = join(f.root, "morning.json");
  const morningConfig = { schema_version: 1, ...f.config.daily };
  const morningArgs = ["daily", "morning", "--once", "--db", f.path, "--input", morningInput];
  writeFileSync(morningInput, JSON.stringify(morningConfig));
  const morning = await execute(morningArgs, { clock: () => new Date("2026-08-29T22:15:00.005Z") });
  expect(morning).toMatchObject({ run: { state: "completed" }, usage: { items: 1, work: 2 } });
  const evening = await execute(f.args, { clock: () => at });
  expect(evening).toMatchObject({ run: { state: "completed" }, usage: { items: 1, work: 3 } });
  const saved = snapshot(f.path);
  // An artifact's own key must never be accepted as runtime trust implicitly.
  await expect(execute(morningArgs, { clock: () => at })).rejects.toMatchObject({ code: "DAILY_LOOP_INTEGRITY_FAILURE" });
  writeFileSync(morningInput, JSON.stringify({ ...morningConfig, trusted_closeout_key: f.config.trusted_key }));
  const replay = await execute(morningArgs, { clock: () => at });
  expect(replay.run).toEqual(morning.run); expect(replay.completed_run_ids).toEqual([]);
  expect(replay.usage).toEqual(evening.usage); expect(snapshot(f.path)).toEqual(saved);
  const wrong = generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "der" }).toString("base64url");
  writeFileSync(morningInput, JSON.stringify({ ...morningConfig,
    trusted_closeout_key: { ...f.config.trusted_key, public_key_spki: wrong } }));
  await expect(execute(morningArgs, { clock: () => at })).rejects.toMatchObject({ code: "DAILY_LOOP_INTEGRITY_FAILURE" });
  expect(snapshot(f.path)).toEqual(saved);
});


it("rejects duplicate daily budget fields without preparing work", async () => {
  const f = await fixture(); const before = snapshot(f.path);
  const text = JSON.stringify(f.config).replace('"max_work":', '"max_work":0,"max_work":');
  writeFileSync(f.input, text);
  await expect(execute(f.args, { clock: () => at })).rejects.toMatchObject({ code: "DAILY_LOOP_CONFIG_INVALID" });
  expect(snapshot(f.path)).toEqual(before);
});
