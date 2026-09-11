import { randomUUID } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { closeSync, existsSync, mkdirSync, openSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface, type Interface } from "node:readline";
import { afterEach, expect, it } from "vitest";
import { processStartToken } from "../../src/authority-database-process.js";
import {
  openUnderSwapAdmission, publishSwapBarrier, releaseSwapBarrier, swapBarrierPath,
} from "../../src/authority-database-swap-barrier.js";
import { AuthorityDatabaseRuntime } from "../../src/authority-database-runtime.js";
import { AuthorityDb } from "../../src/db.js";
import { applyLocalObservationRetention } from "../../src/local-observation-retention.js";
import { applyRetentionCandidate } from "../../src/local-observation-retention-swap.js";
import { localObservationChain } from "../fixtures/local-observation-chain.js";
import { tempDb } from "../helpers.js";

const HOLDER = join(process.cwd(), "tests", "fixtures", "local-retention-writer-holder.mjs");

type Child = {
  readonly child: ChildProcessWithoutNullStreams;
  /** Registered at spawn, so a child that exits immediately is never waited for in vain. */
  readonly exited: Promise<unknown>;
  readonly line: Promise<string>;
};

const opened: AuthorityDb[] = [];
const children: Child[] = [];
const readers: Interface[] = [];
afterEach(() => {
  for (const reader of readers.splice(0)) reader.close();
  for (const item of children.splice(0)) {
    if (item.child.exitCode === null) item.child.kill("SIGKILL");
  }
  for (const db of opened.splice(0)) if (db.db.open) db.close();
});

const observations = (db: AuthorityDb): number =>
  Number(db.db.prepare("SELECT COUNT(*) FROM personal_observations").pluck().get());
const inode = (path: string): string => statSync(path, { bigint: true }).ino.toString();

/**
 * Starts the fixture and hands back both of its signals.
 *
 * The exit promise is registered before the child can do anything, because a child that finishes
 * quickly would otherwise exit before anyone listened and leave the wait hanging until the test
 * timed out. Nothing here waits on a duration.
 */
function announce(database: string, mode: string): Child {
  const child = spawn(process.execPath, [HOLDER, database, mode], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  const exited = once(child, "exit");
  const reader = createInterface({ input: child.stdout });
  readers.push(reader);
  const iterator = reader[Symbol.asyncIterator]();
  const line = iterator.next().then(first => {
    if (first.done === true) throw new Error("RETENTION_HOLDER_FIXTURE_SILENT");
    return first.value;
  });
  const item = { child, exited, line };
  children.push(item);
  return item;
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
    const holder = announce(db.filename, "hold");
    expect(await holder.line).toBe("holding");

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
    // The write-ahead log of a connection that is still open was not removed on the way out.
    expect(db.db.open).toBe(true);

    holder.child.stdin.write("release\n");
    await holder.exited;

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
  const refused = announce(db.filename, "open");
  const message = await refused.line;
  await refused.exited;
  expect(JSON.parse(message.replace(/^refused /, "")))
    .toEqual({ code: "AUTHORITY_DATABASE_SWAP_IN_PROGRESS" });

  releaseSwapBarrier(db.filename);
  const admitted = announce(db.filename, "open");
  expect(await admitted.line).toBe("opened");
  await admitted.exited;
}, 60_000);

it("gives a connection up when a swap begins while it is being opened", async () => {
  const db = new AuthorityDb(tempDb());
  opened.push(db);
  db.close();
  // A live process that is not this one, standing in for the swap that publishes between the two
  // halves of an open. It only has to exist: the barrier record names its pid and start token, and
  // that is exactly what a real swap would write.
  const owner = announce(db.filename, "idle");
  expect(await owner.line).toBe("idle");
  const ownerPid = owner.child.pid ?? 0;
  expect(ownerPid).toBeGreaterThan(0);

  let closed = 0;
  const barrier = swapBarrierPath(db.filename);
  // The record names the database the way the barrier itself is named, which is how any spelling
  // of one file becomes one exclusion.
  const named = barrier.slice(0, -".swap-barrier".length);
  const attempt = (): unknown => openUnderSwapAdmission(db.filename, () => {
    writeFileSync(barrier, `${JSON.stringify({
      schema_version: 1, pid: ownerPid, start_token: processStartToken(ownerPid),
      operation_token: randomUUID(), database: named, reason: "local_retention",
      created_at: new Date().toISOString(),
    })}\n`, { mode: 0o600 });
    const descriptor = openSync(db.filename, "r");
    return { close: () => { closeSync(descriptor); closed += 1; } };
  });
  // One check could not see this barrier: it was published after the check and before the
  // descriptor existed, which is the window the swap's own scan cannot cover either.
  expect(attempt).toThrow("AUTHORITY_DATABASE_SWAP_IN_PROGRESS");
  expect(closed).toBe(1);
}, 60_000);

it("lets exactly one of two processes take the barrier", async () => {
  const db = new AuthorityDb(tempDb());
  opened.push(db);
  db.close();
  const first = announce(db.filename, "abandon");
  const second = announce(db.filename, "abandon");
  const outcomes = [await first.line, await second.line].sort();
  // Whichever order the two reach the create in, the file is created exclusively, so one of them
  // holds the barrier and the other is told a swap is already in progress. Both succeeding is the
  // failure this asserts against, and it does not depend on which one wins.
  expect(outcomes).toEqual(["published", "refused"]);
  expect(existsSync(swapBarrierPath(db.filename))).toBe(true);
}, 60_000);

it("does not let a barrier outlive the process that took it", async () => {
  const db = new AuthorityDb(tempDb());
  opened.push(db);
  db.close();
  const abandoned = announce(db.filename, "abandon");
  expect(await abandoned.line).toBe("published");
  expect(existsSync(swapBarrierPath(db.filename))).toBe(true);
  abandoned.child.kill("SIGKILL");
  await abandoned.exited;

  // The owner is gone, so the record is debris rather than an exclusion, and the database opens.
  const admitted = announce(db.filename, "open");
  expect(await admitted.line).toBe("opened");
  await admitted.exited;
  // Reading does not remove it. Deciding a record is debris and clearing it are two acts, and a
  // reader that did both could unlink a record that had just become somebody's live claim, so
  // removal belongs to the writers that hold the lock. The file therefore outlives its owner.
  expect(existsSync(swapBarrierPath(db.filename))).toBe(true);

  // And it blocks nothing: the next swap reclaims the name and takes it.
  const taken = publishSwapBarrier(db.filename, "local_retention", new Date());
  expect(taken.pid).toBe(process.pid);
  releaseSwapBarrier(db.filename);
  expect(existsSync(swapBarrierPath(db.filename))).toBe(false);
}, 60_000);

it("refuses a holder that appears after the probe and before the rename", async () => {
  const { db, runtime, cutoff } = await seeded();
  const application = await applyLocalObservationRetention(db, cutoff,
    join(dirname(db.filename), "late-holder-candidate"));
  const before = { inode: inode(db.filename), observations: observations(db) };

  // The window a byte comparison cannot see: the source was unheld through every earlier question
  // and the holder arrives on the last one, idle, having written nothing yet. Delivered by call
  // order rather than by timing, because a real process cannot be synchronised into an interval
  // bounded by two synchronous calls without a poll loop.
  const observe = runtime.observeOldInode.bind(runtime);
  // The window is named by its contents, not by a call index: the applied record is in the
  // candidate and the candidate is still a separate file, which is true on exactly one question -
  // the last one before the rename.
  const insideWindow = () => {
    if (!existsSync(application.operation.candidate_path)) return false;
    const probe = new AuthorityDb(application.operation.candidate_path);
    try {
      return Number(probe.db.prepare(
        "SELECT COUNT(*) FROM local_retention_operations WHERE state='applied'").pluck().get()) > 0;
    } finally { probe.close(); }
  };
  let refusedInWindow = false;
  runtime.observeOldInode = ((device: bigint, ino: bigint) => {
    const real = observe(device, ino);
    if (!insideWindow()) return real;
    refusedInWindow = true;
    return { ...real, fd_count: 1 };
  }) as typeof runtime.observeOldInode;

  await expect(runtime.quiesce("local_retention",
    async () => applyRetentionCandidate(runtime, application, new Date())))
    .rejects.toMatchObject({ code: "LOCAL_RETENTION_SOURCE_WRITER_ACTIVE" });
  // Refused on the pre-rename question, not an earlier one: the earlier answers were clean.
  expect(refusedInWindow).toBe(true);
  expect(inode(db.filename)).toBe(before.inode);
  expect(observations(db)).toBe(before.observations);
  expect(existsSync(application.operation.candidate_path)).toBe(true);
  expect(existsSync(swapBarrierPath(db.filename))).toBe(false);
}, 60_000);
