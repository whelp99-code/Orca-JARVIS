import {
  closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, rmSync, writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import { canonicalize } from "./canonical.js";
import { processStartToken, ProcessObservationError } from "./authority-database-process.js";
import { JarvisError } from "./jarvis-error.js";

const BarrierSchema = z.object({
  schema_version: z.literal(1),
  pid: z.number().int().positive(),
  start_token: z.string().regex(/^\d+$/),
  database: z.string().min(1),
  reason: z.enum(["local_retention", "memory_compaction"]),
  created_at: z.string().min(1),
}).strict();

export type AuthoritySwapBarrier = z.infer<typeof BarrierSchema>;

/**
 * The barrier for a database, named from the database itself.
 *
 * Every connection is opened from a pathname and nothing else, so the barrier has to be derivable
 * from that pathname: a process that is about to be excluded cannot be asked to know where some
 * registry lives. SQLite owns the `-wal`, `-shm` and `-journal` suffixes; this one is ours.
 */
export function swapBarrierPath(database: string): string {
  return `${database}.swap-barrier`;
}

/**
 * The barrier standing over a database right now, if one is.
 *
 * A record whose owner is gone is debris from a process that died mid-swap, not a live exclusion,
 * and it is removed so a crash cannot lock a database out of every future open. The owner's start
 * token separates the process that wrote the record from a later one wearing the same pid.
 */
export function readSwapBarrier(database: string): AuthoritySwapBarrier | undefined {
  const path = swapBarrierPath(database);
  let decoded: unknown;
  try {
    decoded = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    if (error instanceof Error && Reflect.get(error, "code") === "ENOENT") return undefined;
    throw new JarvisError("AUTHORITY_SWAP_BARRIER_INVALID");
  }
  const parsed = BarrierSchema.safeParse(decoded);
  if (!parsed.success || parsed.data.database !== database) {
    throw new JarvisError("AUTHORITY_SWAP_BARRIER_INVALID");
  }
  if (ownerAlive(parsed.data)) return parsed.data;
  rmSync(path, { force: true });
  return undefined;
}

/**
 * Refuses to open a database while another process is replacing the file behind it.
 *
 * This is the admission half of the swap protocol. The scan of open descriptors that runs before a
 * rename can only see connections that already exist; a connection opened a moment later would
 * survive the scan and then write into an inode the rename has orphaned. Publishing the barrier
 * before the scan closes that order: anything admitted before it is seen, and anything after it is
 * refused here. The process holding the barrier is admitted, because it reopens the file itself as
 * the last step of its own swap.
 */
export function assertSwapAdmission(database: string): void {
  const barrier = readSwapBarrier(database);
  if (barrier === undefined || isOwner(barrier)) return;
  throw new JarvisError("AUTHORITY_DATABASE_SWAP_IN_PROGRESS");
}

/** Takes the barrier for this process, refusing while another live process holds it. */
export function publishSwapBarrier(
  database: string, reason: AuthoritySwapBarrier["reason"], now: Date,
): AuthoritySwapBarrier {
  const held = readSwapBarrier(database);
  if (held !== undefined && !isOwner(held)) {
    throw new JarvisError("AUTHORITY_DATABASE_SWAP_IN_PROGRESS");
  }
  const record = BarrierSchema.parse({
    schema_version: 1, pid: process.pid, start_token: processStartToken(process.pid),
    database, reason, created_at: now.toISOString(),
  });
  const path = swapBarrierPath(database);
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, `${canonicalize(record)}\n`, { mode: 0o600, flag: "w" });
  syncPath(temporary);
  renameSync(temporary, path);
  syncPath(dirname(path));
  return record;
}

/** Gives the barrier up. Only the process that took it may. */
export function releaseSwapBarrier(database: string): void {
  const path = swapBarrierPath(database);
  if (!existsSync(path)) return;
  const held = readSwapBarrier(database);
  if (held !== undefined && !isOwner(held)) {
    throw new JarvisError("AUTHORITY_DATABASE_SWAP_IN_PROGRESS");
  }
  rmSync(path, { force: true });
  syncPath(dirname(path));
}

function isOwner(barrier: AuthoritySwapBarrier): boolean {
  if (barrier.pid !== process.pid) return false;
  try {
    return processStartToken(process.pid) === barrier.start_token;
  } catch (error) {
    if (error instanceof ProcessObservationError) return false;
    throw error;
  }
}

function ownerAlive(barrier: AuthoritySwapBarrier): boolean {
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

function syncPath(path: string): void {
  const descriptor = openSync(path, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}
