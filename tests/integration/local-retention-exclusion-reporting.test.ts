import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { afterEach, expect, it } from "vitest";
import { AuthorityDatabaseRuntime } from "../../src/authority-database-runtime.js";
import { AuthorityDb } from "../../src/db.js";
import { LocalObservationRetentionService } from "../../src/local-observation-retention-service.js";
import { localChainCutoff, localObservationChain } from "../fixtures/local-observation-chain.js";
import { tempDb } from "../helpers.js";

const RETAIN_MS = 3_600_000;
const BINARY = resolve(process.cwd(), "dist/src/cli.js");
const opened: AuthorityDb[] = [];
afterEach(() => { for (const db of opened.splice(0)) if (db.db.open) db.close(); });

const observations = (db: AuthorityDb): number =>
  Number(db.db.prepare("SELECT COUNT(*) FROM personal_observations").pluck().get());

async function seeded() {
  const db = new AuthorityDb(tempDb());
  opened.push(db);
  await localObservationChain(db);
  const expires = localChainCutoff(db);
  const config = join(dirname(db.filename), "retention.json");
  writeFileSync(config, JSON.stringify({ schema_version: 1, retain_ms: RETAIN_MS }));
  const registry = join(dirname(db.filename), "registry");
  mkdirSync(registry, { recursive: true });
  // No seam and no declaration: this runtime answers with whatever this host's /proc gives, holes
  // included, which is the environment the contract is actually about.
  const runtime = new AuthorityDatabaseRuntime(db, { registry_root: registry, watchdog_ms: 1_000 });
  return { db, config, runtime, now: new Date(Date.parse(expires) + RETAIN_MS) };
}

/**
 * An incomplete answer is its own outcome, not a failure and not a wait.
 *
 * Nothing is broken when this host cannot say who holds a file, and there is nothing to wait for
 * either - the same kernel will answer the same way inside this window. What the operator needs is
 * which processes could not be read, so the cycle carries them rather than folding the whole thing
 * into a message string.
 */
it("reports an unprovable environment as its own outcome and replaces nothing", async () => {
  const { db, config, runtime, now } = await seeded();
  const source = statSync(db.filename, { bigint: true });
  const holes = runtime.observeOldInode(source.dev, source.ino).unprovable.length;
  const before = { observations: observations(db), inode: source.ino };

  const cycle = await new LocalObservationRetentionService(db,
    { config_path: config, runtime, interval_ms: RETAIN_MS, clock: () => now }).cycle();

  if (holes === 0) {
    // An environment that can answer completely is allowed to proceed: the contract refuses on
    // holes, not on principle.
    expect(cycle.status).toBe("processed");
    return;
  }

  expect(cycle.status).toBe("unprovable");
  if (cycle.status !== "unprovable") throw new TypeError("unprovable outcome expected");
  expect(cycle.reason).toBe("unreadable_processes");
  expect(cycle.unreadable_processes.length).toBeGreaterThan(0);
  expect(cycle.unreadable_processes.every(pid => Number.isSafeInteger(pid) && pid > 0)).toBe(true);

  // Nothing was replaced: the source is the same file with the same rows, and the candidate this
  // cycle built is still on disk rather than cleaned up as if it had been a mistake.
  const reopened = new AuthorityDb(db.filename);
  opened.push(reopened);
  expect(statSync(reopened.filename, { bigint: true }).ino).toBe(before.inode);
  expect(observations(reopened)).toBe(before.observations);
  const candidate = reopened.db.prepare(
    "SELECT candidate_path FROM local_retention_operations ORDER BY rowid DESC LIMIT 1").pluck().get();
  expect(typeof candidate === "string" && existsSync(candidate)).toBe(true);
}, 120_000);

/**
 * The operator has to be able to read that answer without running a rebuild to get it, and what
 * they get has to be identifiers and counts - enough to go and look, and nothing about what those
 * processes are doing.
 */
it("reports what a swap would find, as identifiers and counts only", async () => {
  const { db } = await seeded();
  expect(existsSync(BINARY), "dist/src/cli.js is required; run npm run build:backend").toBe(true);

  const run = spawnSync(process.execPath,
    [BINARY, "timeline", "retention-preflight", "--db", db.filename], { encoding: "utf8" });
  expect(run.stderr).toBe("");
  expect(run.status).toBe(0);
  const reported = JSON.parse(run.stdout) as { ok: boolean; exclusion: Record<string, unknown> };
  expect(reported.ok).toBe(true);

  const exclusion = reported.exclusion;
  expect(Object.keys(exclusion).sort()).toEqual(["holder_count", "open_descriptor_count", "provable",
    "reason", "unreadable_process_count", "unreadable_processes", "writable_holder_count"]);
  const pids = exclusion["unreadable_processes"];
  expect(Array.isArray(pids)).toBe(true);
  expect((pids as readonly unknown[]).length).toBe(exclusion["unreadable_process_count"]);
  expect((pids as readonly unknown[]).every(pid => typeof pid === "number")).toBe(true);
  expect(exclusion["provable"]).toBe((pids as readonly unknown[]).length === 0
    && exclusion["reason"] === null);
  // Nothing about what those processes are: no command line, no environment, no paths.
  expect(run.stdout).not.toMatch(/cmdline|environ|argv|\/proc\//);
}, 120_000);
