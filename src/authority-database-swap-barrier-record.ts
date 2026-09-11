import {
  closeSync, constants, existsSync, fstatSync, fsyncSync, openSync, readFileSync, rmSync,
} from "node:fs";
import { realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { z } from "zod";
import { processStartToken, ProcessObservationError } from "./authority-database-process.js";

export const BarrierSchema = z.object({
  schema_version: z.literal(1),
  pid: z.number().int().positive(),
  start_token: z.string().regex(/^\d+$/),
  database: z.string().min(1),
  reason: z.enum(["local_retention", "memory_compaction"]),
  created_at: z.string().min(1),
}).strict();

export type AuthoritySwapBarrier = z.infer<typeof BarrierSchema>;

/**
 * One name for one file, whichever way a caller spells it.
 *
 * Two processes exclude each other only if they derive the same barrier, and a database can be
 * named by a relative path, through a symlinked directory, or by an alias. The real path of the
 * parent plus the entry name is the same string for all of them, which is what the retention claim
 * already resolves paths with. A parent that does not exist yet cannot be a live database, so the
 * lexical path stands in and nothing is excluded.
 */
export function canonicalDatabase(database: string): string {
  const absolute = resolve(database);
  try {
    return resolve(realpathSync(dirname(absolute)), absolute.slice(absolute.lastIndexOf("/") + 1));
  } catch {
    return absolute;
  }
}

/** True while this process is the one the record names, same pid and same start token. */
export function isOwner(barrier: AuthoritySwapBarrier): boolean {
  if (barrier.pid !== process.pid) return false;
  try {
    return processStartToken(process.pid) === barrier.start_token;
  } catch (error) {
    if (error instanceof ProcessObservationError) return false;
    throw error;
  }
}

/** True unless the process that wrote the record is provably gone. */
export function ownerAlive(barrier: AuthoritySwapBarrier): boolean {
  if (!existsSync(`/proc/${barrier.pid}`)) return false;
  try {
    return processStartToken(barrier.pid) === barrier.start_token;
  } catch (error) {
    // A process that vanished between the two reads is gone; anything else is unreadable, and an
    // unreadable owner is treated as live so a swap in progress is never overrun by guesswork.
    if (error instanceof ProcessObservationError) return existsSync(`/proc/${barrier.pid}`);
    throw error;
  }
}

/**
 * Removes a path only while it is still the file that was inspected, identified by its bytes.
 *
 * Clearing debris races with the next process taking the barrier for real: it can remove the same
 * dead record and publish its own, and an inode number freed a moment earlier can be handed
 * straight back, so device and inode alone would let this unlink a live barrier and leave two
 * swaps each believing it holds the file. The record names the process that wrote it, its start
 * token and the moment it was written, so comparing the bytes answers the only question that
 * matters: is this still the same record, rather than the same number.
 */
export function removeIdentifiedFile(
  path: string, identity: { readonly dev: bigint; readonly ino: bigint }, contents: string,
): void {
  let descriptor: number;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (error instanceof Error && Reflect.get(error, "code") === "ENOENT") return;
    throw error;
  }
  let present;
  let current: string;
  try {
    present = fstatSync(descriptor, { bigint: true });
    current = readFileSync(descriptor, "utf8");
  } finally {
    closeSync(descriptor);
  }
  if (present.dev !== identity.dev || present.ino !== identity.ino || current !== contents) return;
  rmSync(path, { force: true });
}

export function syncPath(path: string): void {
  const descriptor = openSync(path, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}
