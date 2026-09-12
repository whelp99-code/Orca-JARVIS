import {
  closeSync, constants, existsSync, fstatSync, fsyncSync, linkSync, lstatSync, openSync,
  readFileSync, renameSync, rmSync, writeSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { canonicalize } from "./canonical.js";
import { processStartToken } from "./authority-database-process.js";
import {
  BarrierSchema, canonicalDatabase, isOwner, ownerAlive, syncPath,
  type AuthoritySwapBarrier,
} from "./authority-database-swap-barrier-record.js";
import { withSwapBarrierLock } from "./authority-database-swap-lock.js";
import { JarvisError } from "./jarvis-error.js";
import { settlePublishPhase } from "./local-observation-retention-publish.js";

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
 * The record standing at the barrier path, exactly as it is on disk.
 *
 * Nothing here removes anything. Reading and removing cannot be made one operation against a
 * pathname, so removal belongs to the writers that hold the lock, and this - which every database
 * open calls - only reports. A record that is not a bounded regular file, or does not parse, or
 * names a process that is gone, cannot be a swap in progress: publication writes a complete record
 * under a unique name and links it into place, so a live barrier is always well formed and always
 * has a live owner. Anything else is debris, reported as such and cleared by the next writer.
 */
function barrierRecord(database: string): {
  readonly record?: AuthoritySwapBarrier;
  readonly identity?: { readonly dev: bigint; readonly ino: bigint };
  readonly contents?: string;
  readonly debris: boolean;
} {
  const path = swapBarrierPath(database);
  let descriptor: number;
  try {
    // No symlink is followed and no named pipe can block this open: what is measured and read has
    // to be the file at that name, or it is not read at all.
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if (error instanceof Error && Reflect.get(error, "code") === "ENOENT") return { debris: false };
    return { debris: true };
  }
  let identity;
  let contents: string;
  try {
    identity = fstatSync(descriptor, { bigint: true });
    if (!identity.isFile() || identity.size > 8192) return { debris: true };
    contents = readFileSync(descriptor, "utf8");
  } finally {
    closeSync(descriptor);
  }
  let parsed;
  try {
    parsed = BarrierSchema.safeParse(JSON.parse(contents));
  } catch {
    return { debris: true, identity, contents };
  }
  if (!parsed.success || parsed.data.database !== canonicalDatabase(database)) {
    return { debris: true, identity, contents };
  }
  if (!ownerAlive(parsed.data)) return { debris: true, identity, contents, record: parsed.data };
  return { debris: false, record: parsed.data, identity, contents };
}

/** The live barrier over a database, or nothing when no replacement is in progress. */
export function readSwapBarrier(database: string): AuthoritySwapBarrier | undefined {
  const found = barrierRecord(database);
  return found.debris ? undefined : found.record;
}

/**
 * Refuses to open a database while another process is replacing the file behind it.
 *
 * The process holding the barrier is admitted, because it reopens the file itself as the last step
 * of its own swap.
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
  // A publish that stopped between the rename and the log moving leaves a live name whose log is
  // not its own. Settled here, on identity rather than on the name, before anything opens it.
  settlePublishPhase(database);
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
 * Takes the barrier for this replacement, or refuses because somebody holds it.
 *
 * Everything that can create or remove the barrier path runs under one lock, so clearing a record
 * whose owner is gone and putting ours in its place cannot interleave with another process doing
 * the same. A live record refuses this publication whoever wrote it - including another operation
 * in this process, which is a different holder even though it shares a pid. What is at the path
 * but unreadable as a record is not deleted: it is moved aside under the lock, because an object
 * this cannot account for is preserved, and leaving it would deny every future swap.
 */
export function publishSwapBarrier(
  database: string, reason: AuthoritySwapBarrier["reason"], now: Date,
): AuthoritySwapBarrier {
  const canonical = canonicalDatabase(database);
  const record = BarrierSchema.parse({
    schema_version: 1, pid: process.pid, start_token: processStartToken(process.pid),
    operation_token: randomUUID(), database: canonical, reason, created_at: now.toISOString(),
  });
  const path = swapBarrierPath(database);
  return withSwapBarrierLock(canonical, () => {
    const found = barrierRecord(database);
    if (!found.debris && found.record !== undefined) {
      throw new JarvisError("AUTHORITY_DATABASE_SWAP_IN_PROGRESS");
    }
    if (found.identity !== undefined) rmSync(path, { force: true });
    else if (existsSync(path) || lstatSync(path, { throwIfNoEntry: false }) !== undefined) {
      // Something is there that could not be read as a record: a link, a directory, a pipe. It
      // cannot be a live barrier, and it must not stand in the way for ever, so it is moved aside
      // rather than destroyed and the operator can see what it was.
      renameSync(path, `${path}.${record.operation_token}.unreadable`);
    }
    const staged = `${path}.${record.operation_token}.staged`;
    const descriptor = openSync(staged, "wx", 0o600);
    try {
      writeSync(descriptor, `${canonicalize(record)}\n`);
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    try {
      linkSync(staged, path);
      syncPath(dirname(path));
      return record;
    } finally {
      rmSync(staged, { force: true });
    }
  });
}

/**
 * Gives the barrier up. Only the publication that took it may, identified by its own token.
 */
export function releaseSwapBarrier(database: string, held?: AuthoritySwapBarrier): void {
  const canonical = canonicalDatabase(database);
  const path = swapBarrierPath(database);
  withSwapBarrierLock(canonical, () => {
    const found = barrierRecord(database);
    if (found.identity === undefined) return;
    const record = found.record;
    if (!found.debris && record !== undefined) {
      const mine = isOwner(record)
        && (held === undefined || record.operation_token === held.operation_token);
      if (!mine) throw new JarvisError("AUTHORITY_DATABASE_SWAP_IN_PROGRESS");
    }
    rmSync(path, { force: true });
    syncPath(dirname(path));
  });
}

