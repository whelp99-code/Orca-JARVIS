import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { afterEach, expect, it } from "vitest";
import { AuthorityDatabaseRuntime } from "../../src/authority-database-runtime.js";
import { AuthorityDb } from "../../src/db.js";
import { LocalObservationRetentionService } from "../../src/local-observation-retention-service.js";
import { localObservationChain, LOCAL_CHAIN_AT } from "../fixtures/local-observation-chain.js";
import { tempDb } from "../helpers.js";

const opened: AuthorityDb[] = [];
afterEach(() => { for (const db of opened.splice(0)) if (db.db.open) db.close(); });

const HOUR = 3_600_000;
const scalar = (db: AuthorityDb, sql: string): number => Number(db.db.prepare(sql).pluck().get());
const observations = (db: AuthorityDb): number =>
  scalar(db, "SELECT COUNT(*) FROM personal_observations");
const audits = (db: AuthorityDb): number =>
  scalar(db, "SELECT COUNT(*) FROM personal_context_audit_events");

type Fixture = {
  readonly db: AuthorityDb;
  readonly config: string;
  readonly candidate: string;
  readonly runtime: AuthorityDatabaseRuntime;
  readonly cutoffAt: Date;
};

/** A source with one expired chain and a written configuration document. */
async function fixture(retainMs = 3_600_000): Promise<Fixture> {
  const db = new AuthorityDb(tempDb());
  opened.push(db);
  const chain = await localObservationChain(db);
  const expires = String(db.db
    .prepare("SELECT expires_at FROM personal_observations WHERE observation_id=?")
    .pluck().get(chain.observation.id));
  const config = join(dirname(db.filename), "retention.json");
  writeFileSync(config, JSON.stringify({ schema_version: 1, retain_ms: retainMs }));
  const registry = join(dirname(db.filename), "registry");
  mkdirSync(registry, { recursive: true });
  return {
    db, config,
    candidate: `${db.filename}.retention-candidate`,
    runtime: new AuthorityDatabaseRuntime(db, { registry_root: registry, watchdog_ms: 1000 }),
    // An instant whose window ends exactly at the expiry of the seeded chain.
    cutoffAt: new Date(Date.parse(expires) + retainMs),
  };
}

const service = (fixture: Fixture, options: {
  readonly config?: string | undefined; readonly runtime?: AuthorityDatabaseRuntime;
  readonly now: () => Date;
}): LocalObservationRetentionService =>
  new LocalObservationRetentionService(fixture.db, {
    config_path: options.config, runtime: options.runtime,
    interval_ms: 6 * HOUR, clock: options.now,
  });

it("stays inactive without a configuration and rejects one it cannot read exactly", async () => {
  const seeded = await fixture();
  expect(await service(seeded, { now: () => seeded.cutoffAt }).cycle())
    .toEqual({ status: "inactive" });

  for (const document of [{ schema_version: 1, retain_ms: 3_600_000, extra: true },
    { schema_version: 2, retain_ms: 3_600_000 }, { schema_version: 1, retain_ms: 1000 },
    { schema_version: 1, retain_ms: 31_536_000_001 }, { schema_version: 1, retain_ms: 1.5 }]) {
    writeFileSync(seeded.config, JSON.stringify(document));
    await expect(service(seeded, { config: seeded.config, now: () => seeded.cutoffAt }).cycle())
      .rejects.toThrow("LOCAL_RETENTION_CONFIG_INVALID");
  }
  expect(existsSync(seeded.candidate)).toBe(false);
}, 60_000);

it("reports that it cannot apply when no runtime stands behind it", async () => {
  const seeded = await fixture();
  const before = observations(seeded.db);
  const cycle = await service(seeded, { config: seeded.config, now: () => seeded.cutoffAt })
    .cycle();
  expect(cycle).toEqual({ status: "unsupported", reason: "no_swap_runtime", recovered: [] });
  // Nothing was built: a candidate that could not be installed is not started at all.
  expect(existsSync(seeded.candidate)).toBe(false);
  expect(observations(seeded.db)).toBe(before);
}, 60_000);

it("rebuilds once, records the stage in the database and keeps the audit trail", async () => {
  const seeded = await fixture();
  const before = { observations: observations(seeded.db), audits: audits(seeded.db) };
  const generation = scalar(seeded.db,
    "SELECT generation FROM memory_database_generations WHERE state='active'");
  const cycle = await service(seeded,
    { config: seeded.config, runtime: seeded.runtime, now: () => seeded.cutoffAt }).cycle();

  expect(cycle).toMatchObject({
    status: "processed", recorded_state: "applied", result_generation: generation + 1,
    removed: { observation: 1, context: 1, recommendation: 1 }, recovered: [],
  });
  expect(observations(seeded.db)).toBe(before.observations - 1);
  // Immutable history is not what retention reclaims: the audit rows stay while the cache shrinks.
  expect(audits(seeded.db)).toBe(before.audits);
  expect(scalar(seeded.db,
    "SELECT COUNT(*) FROM local_retention_operations WHERE state='applied'")).toBe(1);
  expect(existsSync(seeded.candidate)).toBe(false);
}, 60_000);

it("holds the window against a duplicate start, a clock that went back and a long outage",
  async () => {
    const seeded = await fixture();
    let now = seeded.cutoffAt;
    const cycles = service(seeded,
      { config: seeded.config, runtime: seeded.runtime, now: () => now });
    expect((await cycles.cycle()).status).toBe("processed");
    const next = new Date(seeded.cutoffAt.getTime() + 6 * HOUR).toISOString();

    // Same instant again, a moment later, and an hour before the first: one window, one run.
    expect(await cycles.cycle()).toEqual({ status: "deferred", next_at: next, recovered: [] });
    now = new Date(seeded.cutoffAt.getTime() + HOUR);
    expect(await cycles.cycle()).toEqual({ status: "deferred", next_at: next, recovered: [] });
    now = new Date(seeded.cutoffAt.getTime() - HOUR);
    expect(await cycles.cycle()).toEqual({ status: "deferred", next_at: next, recovered: [] });
    expect(scalar(seeded.db, "SELECT COUNT(*) FROM local_retention_operations")).toBe(1);

    // A week later the missed windows collapse into one run, not a burst of them.
    now = new Date(seeded.cutoffAt.getTime() + 7 * 24 * HOUR);
    expect((await cycles.cycle()).status).toBe("processed");
    expect((await cycles.cycle()).status).toBe("deferred");
    expect(scalar(seeded.db, "SELECT COUNT(*) FROM local_retention_operations")).toBe(2);
  }, 60_000);

it("stops the next cycle instead of piling candidates beside work it cannot account for",
  async () => {
    const seeded = await fixture();
    // A real process killed after verification, then its candidate replaced by another file.
    const child = spawn(process.execPath, [
      join(process.cwd(), "tests", "fixtures", "local-retention-crash-child.mjs"),
      seeded.db.filename, seeded.candidate, seeded.cutoffAt.toISOString(), "after_verify",
      join(dirname(seeded.db.filename), "registry"), LOCAL_CHAIN_AT,
    ], { stdio: ["ignore", "pipe", "pipe"] });
    const lines = createInterface({ input: child.stdout });
    for await (const line of lines) if (line === "after_verify") break;
    lines.close();
    child.kill("SIGKILL");
    await once(child, "exit");
    rmSync(seeded.candidate);
    writeFileSync(seeded.candidate, "someone else's file\n");

    const cycle = await service(seeded,
      { config: seeded.config, runtime: seeded.runtime, now: () => seeded.cutoffAt }).cycle();
    expect(cycle).toMatchObject({ status: "blocked", unfinished: 1 });
    expect(cycle).toMatchObject({ recovered: [{ outcome: "retained_unproven" }] });
    expect(scalar(seeded.db,
      "SELECT COUNT(*) FROM local_retention_operations WHERE state='applied'")).toBe(0);
  }, 60_000);
