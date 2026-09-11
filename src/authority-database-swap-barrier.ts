import {
  closeSync, constants, fstatSync, fsyncSync, linkSync, openSync, readFileSync, rmSync, writeSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { canonicalize } from "./canonical.js";
import { processStartToken } from "./authority-database-process.js";
import {
  BarrierSchema, canonicalDatabase, isOwner, ownerAlive, removeIdentifiedFile, syncPath,
  type AuthoritySwapBarrier,
} from "./authority-database-swap-barrier-record.js";
import { JarvisError } from "./jarvis-error.js";

export type { AuthoritySwapBarrier } from "./authority-database-swap-barrier-record.js";

/**
 * The barrier for a database, named from the database itself.
 *
 * Every connection is opened from a pathname and nothing else, so the barrier has to be derivable
 * from that pathname: a process that is about to be excluded cannot be asked to know where some
 * registry lives. SQLite owns the `-wal`, `-shm` and `-journal` suffixes; this one is ours.
 */
export function swapBarrierPath(database: string): string {
  return `${canonicalDatabase(database)}.swap-barrier`;
}

/**
 * The barrier standing over a database right now, if one is.
 *
 * A record whose owner is gone is debris from a process that died mid-swap, not a live exclusion,
 * and it is removed so a crash cannot lock a database out of every future open. The owner's start
 * token separates the process that wrote the record from a later one wearing the same pid. The
 * removal names the exact file that was read - same device, inode and link count - so a record
 * published between the read and the unlink is not the one that disappears.
 */
export function readSwapBarrier(database: string): AuthoritySwapBarrier | undefined {
  const path = swapBarrierPath(database);
  let descriptor: number;
  try {
    descriptor = openSync(path, "r");
  } catch (error) {
    if (error instanceof Error && Reflect.get(error, "code") === "ENOENT") return undefined;
    throw new JarvisError("AUTHORITY_SWAP_BARRIER_INVALID");
  }
  let decoded: unknown;
  let identity;
  let contents = "";
  try {
    identity = fstatSync(descriptor, { bigint: true });
    contents = readFileSync(descriptor, "utf8");
    decoded = JSON.parse(contents);
  } catch (error) {
    if (error instanceof SyntaxError) throw new JarvisError("AUTHORITY_SWAP_BARRIER_INVALID");
    throw error;
  } finally {
    closeSync(descriptor);
  }
  const parsed = BarrierSchema.safeParse(decoded);
  if (!parsed.success || parsed.data.database !== canonicalDatabase(database)) {
    throw new JarvisError("AUTHORITY_SWAP_BARRIER_INVALID");
  }
  if (ownerAlive(parsed.data)) return parsed.data;
  removeIdentifiedFile(path, identity, contents);
  return undefined;
}

/**
 * Refuses to open a database while another process is replacing the file behind it.
 *
 * This is the admission half of the swap protocol, and it is asked twice: once before the
 * connection is opened and once after. A single check cannot be enough, because the swap can
 * publish its barrier in the gap, and the descriptor that appears a moment later would survive the
 * scan the swap runs and then write into an inode the rename has orphaned. Asked again afterwards,
 * the opener that lost that race sees the barrier and gives the descriptor up, while an opener that
 * got in first is visible to the scan and refuses the swap instead. The process holding the barrier
 * is admitted throughout, because it reopens the file itself as the last step of its own swap.
 */
export function assertSwapAdmission(database: string): void {
  const barrier = readSwapBarrier(database);
  if (barrier === undefined || isOwner(barrier)) return;
  throw new JarvisError("AUTHORITY_DATABASE_SWAP_IN_PROGRESS");
}

/**
 * Opens something against a database only if no swap is replacing it, and only if none starts
 * while it is being opened.
 *
 * One check cannot close the window: between reading the barrier and the descriptor existing, a
 * swap can publish and run its scan, and the descriptor appearing a moment later would survive
 * that scan and then write into an inode the rename has orphaned. Asking again once the descriptor
 * exists decides the race in every order. If the swap published first, this sees the barrier and
 * gives the descriptor up, so it never reaches the rename. If this opened first, the descriptor was
 * there for the scan to find, and the swap refuses instead. A caller that owns the barrier is
 * admitted throughout, because reopening the file is the last step of its own swap.
 */
export function openUnderSwapAdmission<T extends { close: () => void }>(
  database: string, open: () => T,
): T {
  assertSwapAdmission(database);
  const opened = open();
  try {
    assertSwapAdmission(database);
  } catch (error) {
    opened.close();
    throw error;
  }
  return opened;
}

/**
 * Takes the barrier for this process, or refuses because somebody else has it.
 *
 * Two swaps racing is the situation this whole protocol exists for, so the winner cannot be
 * decided by reading and then writing: both would read an absent barrier and the later write
 * would simply replace the earlier one, leaving each believing it holds the file. The record is
 * written to a unique name first, complete and flushed, and then linked into place - the link is
 * the acquisition, it is atomic, and the kernel refuses the loser. Because the content exists
 * before the name does, a barrier is never observed half-written.
 */
export function publishSwapBarrier(
  database: string, reason: AuthoritySwapBarrier["reason"], now: Date,
): AuthoritySwapBarrier {
  const canonical = canonicalDatabase(database);
  const record = BarrierSchema.parse({
    schema_version: 1, pid: process.pid, start_token: processStartToken(process.pid),
    database: canonical, reason, created_at: now.toISOString(),
  });
  const path = swapBarrierPath(database);
  const staged = `${path}.${randomUUID()}.staged`;
  const descriptor = openSync(staged, "wx", 0o600);
  try {
    writeSync(descriptor, `${canonicalize(record)}\n`);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  try {
    // Two attempts, and only two: the first can lose to a record that turns out to be debris, and
    // clearing that debris is the one thing that makes a second attempt meaningful.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        linkSync(staged, path);
        syncPath(dirname(path));
        return record;
      } catch (error) {
        if (!(error instanceof Error) || Reflect.get(error, "code") !== "EEXIST") throw error;
      }
      // Reading it is what decides whether the name is held or merely occupied: a record whose
      // owner is gone is removed by this read, and a record this process already owns is its own
      // to replace. Anything else belongs to a live swap.
      const held = readSwapBarrier(database);
      if (held !== undefined) {
        if (!isOwner(held)) throw new JarvisError("AUTHORITY_DATABASE_SWAP_IN_PROGRESS");
        rmSync(path, { force: true });
      }
    }
    throw new JarvisError("AUTHORITY_DATABASE_SWAP_IN_PROGRESS");
  } finally {
    rmSync(staged, { force: true });
  }
}

/**
 * Gives the barrier up. Only the process that took it may, and only the record it wrote.
 *
 * The record is read again here rather than trusted from before, so a release removes the file it
 * just proved is its own: bytes and identity together, the same test debris removal uses.
 */
export function releaseSwapBarrier(database: string): void {
  const path = swapBarrierPath(database);
  let descriptor: number;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (error instanceof Error && Reflect.get(error, "code") === "ENOENT") return;
    throw new JarvisError("AUTHORITY_SWAP_BARRIER_INVALID");
  }
  let identity;
  let contents: string;
  try {
    identity = fstatSync(descriptor, { bigint: true });
    contents = readFileSync(descriptor, "utf8");
  } finally {
    closeSync(descriptor);
  }
  let parsed;
  try {
    parsed = BarrierSchema.safeParse(JSON.parse(contents));
  } catch {
    throw new JarvisError("AUTHORITY_SWAP_BARRIER_INVALID");
  }
  if (!parsed.success) throw new JarvisError("AUTHORITY_SWAP_BARRIER_INVALID");
  if (!isOwner(parsed.data)) throw new JarvisError("AUTHORITY_DATABASE_SWAP_IN_PROGRESS");
  removeIdentifiedFile(path, identity, contents);
  syncPath(dirname(path));
}

