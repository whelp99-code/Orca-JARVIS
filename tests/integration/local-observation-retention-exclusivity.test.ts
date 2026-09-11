import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface, type Interface } from "node:readline";
import { afterEach, expect, it } from "vitest";
import {
  publishSwapBarrier, releaseSwapBarrier, swapBarrierPath,
} from "../../src/authority-database-swap-barrier.js";
import { AuthorityDatabaseRuntime } from "../../src/authority-database-runtime.js";
import { AuthorityDb } from "../../src/db.js";
import { applyLocalObservationRetention } from "../../src/local-observation-retention.js";
import { applyRetentionCandidate } from "../../src/local-observation-retention-swap.js";
import { localObservationChain } from "../fixtures/local-observation-chain.js";
import { tempDb } from "../helpers.js";

const HOLDER = join(process.cwd(), "tests", "fixtures", "local-retention-writer-holder.mjs");

const opened: AuthorityDb[] = [];
const children: ChildProcessWithoutNullStreams[] = [];
const readers: Interface[] = [];
afterEach(() => {
  for (const reader of readers.splice(0)) reader.close();
  for (const child of children.splice(0)) if (child.exitCode === null) child.kill("SIGKILL");
  for (const db of opened.splice(0)) if (db.db.open) db.close();
});

const observations = (db: AuthorityDb): number =>
  Number(db.db.prepare("SELECT COUNT(*) FROM personal_observations").pluck().get());
const inode = (path: string): string => statSync(path, { bigint: true }).ino.toString();

/** Starts the fixture and hands back its first line, which it prints once it has really acted. */
async function announce(database: string, mode: string): Promise<{
  readonly child: ChildProcessWithoutNullStreams; readonly line: string;
}> {
  const child = spawn(process.execPath, [HOLDER, database, mode], { stdio: ["pipe", "pipe", "pipe"] });
  children.push(child);
  const reader = createInterface({ input: child.stdout });
  readers.push(reader);
  const iterator = reader[Symbol.asyncIterator]();
  const first = await iterator.next();
  if (first.done === true) throw new Error("RETENTION_HOLDER_FIXTURE_SILENT");
  return { child, line: first.value };
}

async function seeded(): Promise<{
  readonly db: AuthorityDb; readonly runtime: AuthorityDatabaseRuntime; readonly cutoff: string;
}> {
  const db = new AuthorityDb(tempDb());
  opened.push(db);
  const chain = await localObservationChain(db);
  const cutoff = String(db.db
    .prepare("SELECT expires_at FROM personal_observations WHERE observation_id=?")
    .pluck().get(chain.observation.id));
  const registry = join(dirname(db.filename), "registry");
  mkdirSync(registry, { recursive: true });
  return { db, cutoff,
    runtime: new AuthorityDatabaseRuntime(db, { registry_root: registry, watchdog_ms: 5_000 }) };
}

it("refuses to replace a source another process holds open, then swaps once it lets go",
  async () => {
    const { db, runtime, cutoff } = await seeded();
    // The holder joins before the candidate is built, which is what isolates this contract: a
    // process that commits after the build is already refused by the source fence, so the fence is
    // taken with the second connection in place and the only thing left to object is the open
    // descriptor itself. A real second process with a real connection, not a simulated one.
    const holder = await announce(db.filename, "hold");
    expect(holder.line).toBe("holding");

    const application = await applyLocalObservationRetention(db, cutoff,
      join(dirname(db.filename), "exclusive-candidate"));
    const before = { inode: inode(db.filename), observations: observations(db) };

    await expect(runtime.quiesce("local_retention",
      async () => applyRetentionCandidate(runtime, application, new Date())))
      .rejects.toMatchObject({ code: "LOCAL_RETENTION_SOURCE_WRITER_ACTIVE" });
    // The refusal came before the rename: the live database is still the same file, with the same
    // rows, and the candidate it refused to install is still there to be installed later.
    expect(inode(db.filename)).toBe(before.inode);
    expect(observations(db)).toBe(before.observations);
    expect(existsSync(application.operation.candidate_path)).toBe(true);
    expect(existsSync(swapBarrierPath(db.filename))).toBe(false);

    const exited = once(holder.child, "exit");
    holder.child.stdin.write("release\n");
    await exited;

    const result = await runtime.quiesce("local_retention",
      async () => applyRetentionCandidate(runtime, application, new Date()));
    expect(result.old_fd_count).toBe(0);
    expect(inode(db.filename)).not.toBe(before.inode);
    expect(observations(db)).toBe(before.observations - 1);
    expect(existsSync(swapBarrierPath(db.filename))).toBe(false);
  }, 60_000);

it("refuses a connection opened while a swap holds the barrier, and admits one after", async () => {
  const db = new AuthorityDb(tempDb());
  opened.push(db);
  publishSwapBarrier(db.filename, "local_retention", new Date());
  const refused = await announce(db.filename, "open");
  await once(refused.child, "exit");
  expect(JSON.parse(refused.line.replace(/^refused /, "")))
    .toEqual({ code: "AUTHORITY_DATABASE_SWAP_IN_PROGRESS" });

  releaseSwapBarrier(db.filename);
  const admitted = await announce(db.filename, "open");
  await once(admitted.child, "exit");
  expect(admitted.line).toBe("opened");
}, 60_000);

it("does not let a barrier outlive the process that took it", async () => {
  const db = new AuthorityDb(tempDb());
  opened.push(db);
  db.close();
  const abandoned = await announce(db.filename, "abandon");
  expect(abandoned.line).toBe("published");
  expect(existsSync(swapBarrierPath(db.filename))).toBe(true);
  abandoned.child.kill("SIGKILL");
  await once(abandoned.child, "exit");

  // The owner is gone, so the record is debris rather than an exclusion, and the database opens.
  const admitted = await announce(db.filename, "open");
  await once(admitted.child, "exit");
  expect(admitted.line).toBe("opened");
  expect(existsSync(swapBarrierPath(db.filename))).toBe(false);
}, 60_000);
