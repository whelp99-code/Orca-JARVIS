import { spawn } from "node:child_process";
import { withProvableExclusion } from "../fixtures/provable-exclusion.js";
import { once } from "node:events";
import {
  existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { afterEach, expect, it } from "vitest";
import { AuthorityDatabaseRuntime } from "../../src/authority-database-runtime.js";
import { AuthorityDb } from "../../src/db.js";
import {
  applyLocalObservationRetention, stagedClaimPath,
} from "../../src/local-observation-retention.js";
import { applyRetentionCandidate } from "../../src/local-observation-retention-swap.js";
import { recoverLocalRetentionOperations } from "../../src/local-observation-retention-recovery.js";
import { localObservationChain, LOCAL_CHAIN_AT } from "../fixtures/local-observation-chain.js";
import { tempDb } from "../helpers.js";

const opened: AuthorityDb[] = [];
afterEach(() => { for (const db of opened.splice(0)) if (db.db.open) db.close(); });

const scalar = (db: AuthorityDb, sql: string): number =>
  Number(db.db.prepare(sql).pluck().get());
const rows = (db: AuthorityDb, sql: string): unknown[] => db.db.prepare(sql).all();

type Seed = {
  readonly path: string;
  /** The directory the operation owns; the candidate file lives inside it. */
  readonly candidate: string;
  readonly candidateFile: string;
  readonly cutoff: string;
  readonly observation: string;
  readonly observations: number;
};

/** A source with one expired chain, closed: the child process must be its only holder. */
async function seeded(): Promise<Seed> {
  const db = new AuthorityDb(tempDb());
  const chain = await localObservationChain(db);
  // Past both of the chain's observations: a cutoff reaching only the local collection leaves the
  // live fact it was cited beside still current, and the group is correctly retained instead.
  const cutoff = String(db.db.prepare("SELECT MAX(expires_at) FROM personal_observations").pluck().get());
  const seed = {
    path: db.filename,
    candidate: join(dirname(db.filename), "operation"),
    candidateFile: join(dirname(db.filename), "operation", "candidate.sqlite"),
    cutoff,
    observation: chain.observation.id,
    observations: scalar(db, "SELECT COUNT(*) FROM personal_observations"),
  };
  db.close();
  return seed;
}

/**
 * Runs the rebuild in a real process and kills it at a named point.
 *
 * The child prints the point's name when it gets there and stops; the kill follows that line, so
 * the stop is where the test says it is rather than wherever a sleep happened to land.
 */
async function crashAt(seed: Seed, barrier: string): Promise<void> {
  const child = spawn(process.execPath, [
    join(process.cwd(), "tests", "fixtures", "local-retention-crash-child.mjs"),
    seed.path, seed.candidate, seed.cutoff, barrier,
    join(dirname(seed.path), "registry"), LOCAL_CHAIN_AT,
  ], { stdio: ["ignore", "pipe", "pipe"] });
  const failures: string[] = [];
  child.stderr.on("data", chunk => failures.push(String(chunk)));
  const lines = createInterface({ input: child.stdout });
  let reached = false;
  for await (const line of lines) if (line === barrier) { reached = true; break; }
  lines.close();
  child.kill("SIGKILL");
  const [, signal] = await once(child, "exit") as [number | null, string | null];
  if (!reached) throw new Error(`never reached ${barrier}: ${failures.join("")}`);
  expect(signal).toBe("SIGKILL");
}

function reopen(seed: Seed): AuthorityDb {
  const db = new AuthorityDb(seed.path);
  opened.push(db);
  return db;
}

const operations = (db: AuthorityDb): unknown[] => rows(db,
  `SELECT operation_id,state,failure_code,candidate_path,result_device,result_inode
   FROM local_retention_operations`);
const state = (db: AuthorityDb): string =>
  String(db.db.prepare("SELECT state FROM local_retention_operations").pluck().get());

/** The path this operation actually built, derived from the identity the ledger recorded. */
function stagedOf(db: AuthorityDb, seed: Seed): string {
  const row = rows(db, `SELECT operation_id FROM local_retention_operations
    ORDER BY rowid DESC LIMIT 1`)[0] as { operation_id: string } | undefined;
  const id = String(row?.operation_id ?? "").replace(/^retention:/, "");
  return join(dirname(seed.path), `.${basename(seed.candidate)}.${id}.staged`, "candidate.sqlite");
}

it("explains a process killed with the claim recorded and nothing built", async () => {
  const seed = await seeded();
  await crashAt(seed, "after_claim");
  const db = reopen(seed);
  const stagedFile = stagedOf(db, seed);
  expect(state(db)).toBe("preparing");
  expect(scalar(db, "SELECT COUNT(*) FROM personal_observations")).toBe(seed.observations);

  const recovered = recoverLocalRetentionOperations(db, new Date(LOCAL_CHAIN_AT));
  expect(recovered.map(item => item.outcome)).toEqual(["removed_partial"]);
  expect(recovered[0]?.candidate_path).toBe(stagedFile);
  expect(existsSync(dirname(stagedFile))).toBe(false);
  expect(state(db)).toBe("abandoned");
  expect(scalar(db, "SELECT COUNT(*) FROM personal_observations")).toBe(seed.observations);
}, 60_000);

it("removes a half-copied candidate and leaves the source able to try again", async () => {
  const seed = await seeded();
  await crashAt(seed, "during_copy");
  const db = reopen(seed);
  const stagedFile = stagedOf(db, seed);
  expect(state(db)).toBe("preparing");
  expect(statSync(stagedFile).size).toBeGreaterThan(0);

  const recovered = recoverLocalRetentionOperations(db, new Date(LOCAL_CHAIN_AT));
  expect(recovered.map(item => item.outcome)).toEqual(["removed_partial"]);
  expect(existsSync(dirname(stagedFile))).toBe(false);
  expect(scalar(db, "SELECT COUNT(*) FROM personal_observations")).toBe(seed.observations);
  // The path is claimable again, which is what makes the retry possible at all.
  await crashAt(seed, "after_claim");
  expect(rows(db, "SELECT 1 FROM local_retention_operations WHERE state='preparing'").length)
    .toBe(1);
}, 60_000);

it("discards a verified candidate its process never applied, losing nothing", async () => {
  const seed = await seeded();
  await crashAt(seed, "after_verify");
  const db = reopen(seed);
  const stagedFile = stagedOf(db, seed);
  expect(state(db)).toBe("verified");

  const recovered = recoverLocalRetentionOperations(db, new Date(LOCAL_CHAIN_AT));
  expect(recovered.map(item => item.outcome)).toEqual(["removed_unapplied"]);
  expect(existsSync(dirname(stagedFile))).toBe(false);
  expect(scalar(db, "SELECT COUNT(*) FROM personal_observations")).toBe(seed.observations);
  expect(scalar(db, `SELECT COUNT(*) FROM personal_observations WHERE observation_id='${seed.observation}'`))
    .toBe(1);
}, 60_000);

it("keeps the source intact when the process dies one step before the swap", async () => {
  const seed = await seeded();
  await crashAt(seed, "before_swap");
  const db = reopen(seed);
  const stagedFile = stagedOf(db, seed);
  expect(state(db)).toBe("verified");
  const candidate = new AuthorityDb(stagedFile);
  opened.push(candidate);
  // The applied record is written into the candidate, so a candidate that never went live has none.
  expect(scalar(candidate, "SELECT COUNT(*) FROM local_retention_operations")).toBe(0);
  expect(scalar(candidate, "SELECT COUNT(*) FROM personal_observations"))
    .toBeLessThan(seed.observations);
  candidate.close();

  const recovered = recoverLocalRetentionOperations(db, new Date(LOCAL_CHAIN_AT));
  expect(recovered.map(item => item.outcome)).toEqual(["removed_unapplied"]);
  expect(scalar(db, "SELECT COUNT(*) FROM personal_observations")).toBe(seed.observations);
}, 60_000);

it("leaves an applied database that explains its own history when the process dies after the swap",
  async () => {
    const seed = await seeded();
    await crashAt(seed, "after_swap");
    const live = statSync(seed.path, { bigint: true });
    const db = reopen(seed);
    const stagedFile = stagedOf(db, seed);
    expect(operations(db)).toEqual([{
      operation_id: expect.stringMatching(/^retention:/) as unknown,
      state: "applied",
      failure_code: null,
      candidate_path: stagedFile,
      result_device: live.dev.toString(),
      result_inode: live.ino.toString(),
    }]);
    expect(scalar(db, "SELECT COUNT(*) FROM personal_observations"))
      .toBeLessThan(seed.observations);
    expect(scalar(db, `SELECT COUNT(*) FROM personal_observations WHERE observation_id='${seed.observation}'`))
      .toBe(0);
    expect(existsSync(dirname(stagedFile))).toBe(false);
    expect(recoverLocalRetentionOperations(db, new Date(LOCAL_CHAIN_AT))).toEqual([]);
  });

it("preserves a file at the claimed path that this operation did not create", async () => {
  const seed = await seeded();
  await crashAt(seed, "during_copy");
  const db = reopen(seed);
  const stagedFile = stagedOf(db, seed);
  const claimed = statSync(stagedFile, { bigint: true });
  // Somebody else's file under the same name, inside the directory this operation owns. It is
  // created while the candidate still exists and renamed over it, so it cannot be handed the
  // candidate's inode number; the filesystem may recycle that number later, which is why birth
  // time is recorded with it.
  const foreign = `${stagedFile}.foreign`;
  writeFileSync(foreign, "not the candidate\n");
  rmSync(stagedFile);
  renameSync(foreign, stagedFile);
  const replaced = statSync(stagedFile, { bigint: true });
  expect([replaced.ino, replaced.birthtimeNs]).not.toEqual([claimed.ino, claimed.birthtimeNs]);

  const recovered = recoverLocalRetentionOperations(db, new Date(LOCAL_CHAIN_AT));
  expect(recovered.map(item => item.outcome)).toEqual(["retained_unproven"]);
  expect(readFileSync(stagedFile, "utf8")).toBe("not the candidate\n");
  // Unproven work stays unfinished on the record too: nothing here decides what that file is.
  expect(state(db)).toBe("preparing");
}, 60_000);

it("refuses to install a candidate whose bytes changed after it was verified", async () => {
  const seed = await seeded();
  const db = reopen(seed);
  const application = await applyLocalObservationRetention(db, seed.cutoff, seed.candidate,
    new Date(LOCAL_CHAIN_AT));

  // Same path, same inode, same birth time, different bytes.
  const candidate = new AuthorityDb(application.operation.candidate_path);
  candidate.db.pragma("user_version = 42");
  candidate.db.pragma("wal_checkpoint(TRUNCATE)");
  candidate.close();

  const registry = join(dirname(seed.path), "registry-tamper");
  mkdirSync(registry, { recursive: true });
  const runtime = new AuthorityDatabaseRuntime(db, { registry_root: registry, watchdog_ms: 1000 });
  // Declared, not assumed: this case needs an environment where exclusion is provable.
  withProvableExclusion(runtime);
  await expect(runtime.quiesce("local_retention",
    async () => applyRetentionCandidate(runtime, application, new Date(LOCAL_CHAIN_AT))))
    .rejects.toThrow("LOCAL_RETENTION_CANDIDATE_MODIFIED");
}, 60_000);

it("writes the verified digest once and refuses to have it rewritten", async () => {
  const seed = await seeded();
  const db = reopen(seed);
  await applyLocalObservationRetention(db, seed.cutoff, seed.candidate, new Date(LOCAL_CHAIN_AT));

  const recorded = String(db.db.prepare("SELECT verified_digest FROM local_retention_operations")
    .pluck().get());
  expect(recorded).toMatch(/^sha256:[0-9a-f]{64}$/);
  // Rewriting it would let a verified operation point at bytes nobody checked.
  expect(() => db.db.prepare("UPDATE local_retention_operations SET verified_digest=?")
    .run(`sha256:${"f".repeat(64)}`)).toThrow("retention verified digest is written once");
  expect(String(db.db.prepare("SELECT verified_digest FROM local_retention_operations").pluck().get()))
    .toBe(recorded);
}, 60_000);

it("leaves an operation alone while the process that owns it is still running", async () => {
  const seed = await seeded();
  const child = spawn(process.execPath, [
    join(process.cwd(), "tests", "fixtures", "local-retention-crash-child.mjs"),
    seed.path, seed.candidate, seed.cutoff, "after_claim",
    join(dirname(seed.path), "registry"), LOCAL_CHAIN_AT,
  ], { stdio: ["ignore", "pipe", "pipe"] });
  try {
    const lines = createInterface({ input: child.stdout });
    let reached = false;
    for await (const line of lines) if (line === "after_claim") { reached = true; break; }
    lines.close();
    expect(reached).toBe(true);

    // The child is held, not killed: its row says `preparing` exactly like a crashed one would.
    const db = reopen(seed);
    const stagedFile = stagedOf(db, seed);
    const recovered = recoverLocalRetentionOperations(db, new Date(LOCAL_CHAIN_AT));
    expect(recovered.map(item => item.outcome)).toEqual(["retained_active"]);
    expect(state(db)).toBe("preparing");
    expect(existsSync(dirname(stagedFile))).toBe(true);
  } finally {
    child.kill("SIGKILL");
    await once(child, "exit");
  }
}, 60_000);

// Reported by review as P1-C2: an intent records what a run meant to create. Recovery was reading
// it as proof that the object now at that path is the one it created.
it("keeps a directory an intent never proved it created", async () => {
  const seed = await seeded();
  const db = reopen(seed);
  const foreign = seed.candidate;
  mkdirSync(foreign, { recursive: true });
  writeFileSync(join(foreign, "sentinel.txt"), "somebody else's directory");
  // A process that wrote the intent and died before creating anything: no identity was recorded.
  const dead = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  await once(dead, "exit");
  db.db.prepare(
    `INSERT INTO local_retention_claim_intents(operation_id,owner_token,owner_start_token,
      directory,created_at) VALUES(?,?,?,?,?)`,
  ).run("retention:intent-only", `${dead.pid}:token`, "1", foreign, LOCAL_CHAIN_AT);

  const recovered = recoverLocalRetentionOperations(db, new Date(LOCAL_CHAIN_AT));

  expect(recovered.map(item => item.outcome)).toEqual(["retained_unproven"]);
  expect(readFileSync(join(foreign, "sentinel.txt"), "utf8")).toBe("somebody else's directory");
  // The intent stays too: it is the only record that something here is unaccounted for.
  expect(db.db.prepare("SELECT COUNT(*) FROM local_retention_claim_intents").pluck().get()).toBe(1);
}, 60_000);

it("does not decide a claim is abandoned when it cannot read the owner", async () => {
  const seed = await seeded();
  const db = reopen(seed);
  mkdirSync(seed.candidate, { recursive: true });
  writeFileSync(join(seed.candidate, "sentinel.txt"), "unreadable owner");
  // No start token: nothing here says the process that wrote this is gone.
  db.db.prepare(
    `INSERT INTO local_retention_claim_intents(operation_id,owner_token,owner_start_token,
      directory,created_at) VALUES(?,?,NULL,?,?)`,
  ).run("retention:unknown-owner", "999999999:token", seed.candidate, LOCAL_CHAIN_AT);

  expect(recoverLocalRetentionOperations(db, new Date(LOCAL_CHAIN_AT)).map(item => item.outcome))
    .toEqual(["retained_active"]);
  expect(readFileSync(join(seed.candidate, "sentinel.txt"), "utf8")).toBe("unreadable owner");
}, 60_000);

// Reported by review: the destination used to be created before its identity was recorded, so a
// death in between left a directory nobody could prove. Preserving it - which is the right answer
// for an unproven object - then refused that destination to every later run, for good.
it("frees the destination a run that died before recording identity never reached", async () => {
  const seed = await seeded();
  await crashAt(seed, "before_identity");
  const db = reopen(seed);

  // The destination was never taken; the dead run's work is under its own staged name.
  expect(existsSync(seed.candidate)).toBe(false);
  const intents = rows(db, "SELECT operation_id FROM local_retention_claim_intents");
  expect(intents).toHaveLength(1);
  const operationId = String(Reflect.get(intents[0] as object, "operation_id"));
  const staged = stagedClaimPath(seed.candidate, operationId);
  expect(existsSync(staged)).toBe(true);

  const recovered = recoverLocalRetentionOperations(db, new Date(LOCAL_CHAIN_AT));
  // No identity was recorded for it, so it is not proved to be ours and is left alone. Reported by
  // review: the name this run chose is not a claim on whatever is wearing it.
  expect(recovered).toEqual([{ operation_id: operationId, recorded_state: "preparing",
    candidate_path: seed.candidateFile, outcome: "retained_unproven" }]);
  expect(existsSync(staged)).toBe(true);
  expect(scalar(db, "SELECT COUNT(*) FROM local_retention_claim_intents")).toBe(0);

  // The point of the change: the destination it announced was never taken, so it is free again.
  const application = await applyLocalObservationRetention(db, seed.cutoff, seed.candidate);
  expect(existsSync(application.operation.candidate_path)).toBe(true);
  expect(scalar(db, "SELECT COUNT(*) FROM local_retention_operations WHERE state='verified'"))
    .toBe(1);
}, 60_000);

it("recovers a staged claim whose identity it can still prove", async () => {
  const seed = await seeded();
  await crashAt(seed, "after_identity");
  const db = reopen(seed);
  const operationId = String(db.db
    .prepare("SELECT operation_id FROM local_retention_claim_intents").pluck().get());
  const staged = stagedClaimPath(seed.candidate, operationId);
  expect(existsSync(staged)).toBe(true);
  expect(existsSync(seed.candidate)).toBe(false);

  const recovered = recoverLocalRetentionOperations(db, new Date(LOCAL_CHAIN_AT));
  // The identity recorded for that directory still describes it, so it is this lane's own work.
  expect(recovered).toEqual([{ operation_id: operationId, recorded_state: "preparing",
    candidate_path: seed.candidateFile, outcome: "removed_partial" }]);
  expect(existsSync(staged)).toBe(false);
  expect(scalar(db, "SELECT COUNT(*) FROM local_retention_claim_intents")).toBe(0);
}, 60_000);

it("leaves an object squatting a staged name exactly as it was", async () => {
  const seed = await seeded();
  await crashAt(seed, "before_identity");
  const db = reopen(seed);
  const operationId = String(db.db
    .prepare("SELECT operation_id FROM local_retention_claim_intents").pluck().get());
  const staged = stagedClaimPath(seed.candidate, operationId);
  // Somebody else's object at that name, with the dead run's own directory gone.
  rmSync(staged, { recursive: true, force: true });
  mkdirSync(staged, { recursive: true });
  writeFileSync(join(staged, "sentinel.txt"), "not ours\n");

  const recovered = recoverLocalRetentionOperations(db, new Date(LOCAL_CHAIN_AT));
  expect(recovered).toEqual([{ operation_id: operationId, recorded_state: "preparing",
    candidate_path: seed.candidateFile, outcome: "retained_unproven" }]);
  expect(readFileSync(join(staged, "sentinel.txt"), "utf8")).toBe("not ours\n");
}, 60_000);
