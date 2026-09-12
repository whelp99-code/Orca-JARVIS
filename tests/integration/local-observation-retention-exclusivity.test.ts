import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { withProvableExclusion } from "../fixtures/provable-exclusion.js";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { rmSync, linkSync, readdirSync, mkdtempSync, chmodSync, closeSync, existsSync, mkdirSync, openSync, statSync, writeFileSync } from "node:fs";
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
    runtime: withProvableExclusion(
      new AuthorityDatabaseRuntime(db, { registry_root: registry, watchdog_ms: 5_000 })) };
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

it("refuses before removing anything when the source is writable outside this user", async () => {
  const { db, runtime, cutoff } = await seeded();
  // A writer that never has to appear in this user's /proc: the file itself admits one. Set before
  // the fence is taken, so the refusal under test is the exclusion one and not a changed source.
  chmodSync(db.filename, 0o666);
  const application = await applyLocalObservationRetention(db, cutoff,
    join(dirname(db.filename), "outside-writable-candidate"));
  const before = { inode: inode(db.filename), observations: observations(db) };

  await expect(runtime.quiesce("local_retention",
    async () => applyRetentionCandidate(runtime, application, new Date())))
    .rejects.toMatchObject({ code: "LOCAL_RETENTION_EXCLUSION_UNPROVABLE" });
  // Refused before the destructive half: the source, its log and the candidate are all still here.
  expect(inode(db.filename)).toBe(before.inode);
  expect(observations(db)).toBe(before.observations);
  expect(existsSync(`${db.filename}-wal`)).toBe(true);
  expect(existsSync(application.operation.candidate_path)).toBe(true);
  expect(existsSync(swapBarrierPath(db.filename))).toBe(false);

  // Once the file admits only this user again, the work goes through. The refused attempt moved
  // the source's fence past this candidate, so the retry builds its own rather than reusing one
  // the source has already left behind.
  chmodSync(db.filename, 0o600);
  const retry = await applyLocalObservationRetention(db, cutoff,
    join(dirname(db.filename), "outside-writable-retry"));
  const result = await runtime.quiesce("local_retention",
    async () => applyRetentionCandidate(runtime, retry, new Date()));
  expect(result.old_fd_count).toBe(0);
  expect(inode(db.filename)).not.toBe(before.inode);
  expect(observations(db)).toBe(before.observations - 1);
}, 60_000);

it("refuses on an environment whose answer has a hole, and preserves everything it was asked to replace",
  async () => {
    // No seam and no injection: this runtime answers with whatever this host's /proc gives, holes
    // included. The contract is that a destructive replacement does not happen on an answer like
    // that, so the assertion is about what is still here afterwards.
    const seeds = await seeded();
    const db = seeds.db;
    const cutoff = seeds.cutoff;
    // The harness declares its environment provable; this case asks the host directly instead.
    const runtime = new AuthorityDatabaseRuntime(db,
      { registry_root: mkdtempSync(join(dirname(db.filename), "registry-")), watchdog_ms: 5_000 });
    const application = await applyLocalObservationRetention(db, cutoff,
      join(dirname(db.filename), "unprovable-environment-candidate"));
    const before = { inode: inode(db.filename), observations: observations(db) };
    const source = statSync(db.filename, { bigint: true });
    const holes = runtime.observeOldInode(source.dev, source.ino).unprovable.length;

    const attempt = runtime.quiesce("local_retention",
      async () => applyRetentionCandidate(runtime, application, new Date()));
    if (holes === 0) {
      // An environment that can answer completely is allowed to proceed: the contract refuses on
      // holes, not on principle.
      await expect(attempt).resolves.toMatchObject({ old_fd_count: 0 });
      expect(inode(db.filename)).not.toBe(before.inode);
      return;
    }
    await expect(attempt).rejects.toMatchObject({ code: "LOCAL_RETENTION_EXCLUSION_UNPROVABLE" });
    // Refused before the destructive half: source, rows, log, candidate and no barrier left behind.
    expect(inode(db.filename)).toBe(before.inode);
    expect(observations(db)).toBe(before.observations);
    expect(existsSync(`${db.filename}-wal`)).toBe(true);
    expect(existsSync(application.operation.candidate_path)).toBe(true);
    expect(existsSync(swapBarrierPath(db.filename))).toBe(false);
  }, 60_000);

it("keeps the source, its log and the candidate when a writer commits after the last question",
  async () => {
    const { db, runtime, cutoff } = await seeded();
    const application = await applyLocalObservationRetention(db, cutoff,
      join(dirname(db.filename), "post-check-writer-candidate"));
    const source = db.filename;
    const before = inode(source);

    // Fired on the LAST question only. The applied record is written into the candidate immediately
    // before that question and the candidate is still a separate file until the publish, so this
    // condition is true on exactly one observation - not on the foreign-holder scan that runs long
    // before it, which an existsSync on the candidate would also have matched.
    const applied = () => {
      if (!existsSync(application.operation.candidate_path)) return false;
      const probe = new Database(application.operation.candidate_path, { readonly: true });
      try {
        return Number(probe.prepare(
          "SELECT COUNT(*) FROM local_retention_operations WHERE state='applied'").pluck().get()) > 0;
      } finally { probe.close(); }
    };
    let late: Database.Database | undefined;
    const observe = runtime.observeOldInode.bind(runtime);
    runtime.observeOldInode = ((device: bigint, ino: bigint) => {
      const answer = observe(device, ino);
      if (late !== undefined || !applied()) return answer;
      // A real connection, opened and committed synchronously, and left OPEN across the publish
      // with its write-ahead log in hand. Nothing here is simulated: SQLite writes the row.
      late = new Database(source);
      late.pragma("journal_mode = WAL");
      late.prepare(`INSERT INTO gjc_intents(intent_id,continuation_id,kind,payload_json,
        payload_digest,idempotency_key,state,created_at) VALUES('late-writer','task:late','dispatch',
        '{}','sha256:late','late','pending','2026-08-28T12:00:00.000Z')`).run();
      // Answered as it would have been a moment earlier: the check passed, the writer came after.
      return { ...answer, fd_count: 0, unprovable: [] };
    }) as typeof runtime.observeOldInode;

    // The swap publishes and then reports what it found: a descriptor still holds the retired
    // inode, which is exactly what a writer that arrived after the last question looks like. The
    // report is the contract - it is not silence, and it is not a loss.
    await expect(runtime.quiesce("local_retention",
      async () => applyRetentionCandidate(runtime, application, new Date())))
      .rejects.toMatchObject({ code: "LOCAL_RETENTION_OLD_DATABASE_FD_ACTIVE" });
    expect(late).toBeDefined();

    // Publish happened: the live name is a different inode, and it is the database the candidate
    // built - the late row was never part of it.
    expect(inode(source)).not.toBe(before);
    expect(Number(db.db.prepare(
      "SELECT COUNT(*) FROM gjc_intents WHERE intent_id='late-writer'").pluck().get())).toBe(0);

    // Retirement happened, separately from the publish: the original inode still has a name, its
    // log is beside it under the matching name, and the row the late writer committed is readable.
    const retired = readdirSync(dirname(source)).filter(name => name.endsWith(".retired"));
    expect(retired).toHaveLength(1);
    const retiredPath = join(dirname(source), retired[0] as string);
    expect(String(statSync(retiredPath).ino)).toBe(before);
    expect(existsSync(`${retiredPath}-wal`)).toBe(true);
    late?.close();
    const kept = new Database(retiredPath, { readonly: true });
    try {
      expect(Number(kept.prepare(
        "SELECT COUNT(*) FROM gjc_intents WHERE intent_id='late-writer'").pluck().get())).toBe(1);
    } finally { kept.close(); }
  }, 60_000);

it("leaves the original database live when a run stops between retirement and publish", async () => {
  const { db, runtime, cutoff } = await seeded();
  const application = await applyLocalObservationRetention(db, cutoff,
    join(dirname(db.filename), "interrupted-publish-candidate"));
  const source = db.filename;
  const before = { inode: inode(source), observations: observations(db) };

  // The state a process that died between the two calls leaves behind, constructed exactly: the
  // retired name is a second link to the live inode and the candidate has not been published.
  const retiredPath = `${source}.${application.operation.operation_id.replace(/^retention:/, "")}.retired`;
  linkSync(source, retiredPath);

  // The live path never stopped existing, and it is still the original database with its rows.
  expect(existsSync(source)).toBe(true);
  expect(inode(source)).toBe(before.inode);
  expect(String(statSync(retiredPath).ino)).toBe(before.inode);
  expect(observations(db)).toBe(before.observations);
  expect(existsSync(application.operation.candidate_path)).toBe(true);

  // And a restart does not invent one: reopening a live path that is missing fails rather than
  // creating an empty authority where the replaced one used to be.
  db.close();
  rmSync(source);
  expect(() => db.reopen()).toThrow();
  expect(existsSync(source)).toBe(false);
  // Restored from the link the retirement left, which is the point of taking it first.
  linkSync(retiredPath, source);
  db.reopen();
  expect(observations(db)).toBe(before.observations);
  expect(inode(source)).toBe(before.inode);
}, 60_000);
