import { createHash } from "node:crypto";
import { exclusionHole } from "./authority-database-process.js";
import Database from "better-sqlite3";
import { linkSync, existsSync, readFileSync, renameSync, statSync } from "node:fs";
import { dirname } from "node:path";
import type { AuthorityDatabaseRuntime } from "./authority-database-runtime.js";
import { publishSwapBarrier, releaseSwapBarrier } from "./authority-database-swap-barrier.js";
import { JarvisError } from "./jarvis-error.js";
import {
  assertCandidateUnchanged, assertRetentionOperationOwned, recordAppliedRetentionOperation,
  releaseRetentionOperationDirectory,
} from "./local-observation-retention-operation.js";
import { retentionSourceMoved,
  type LocalObservationRetentionApplication } from "./local-observation-retention.js";
import { syncPath } from "./memory-authority-swap.js";

export type RetentionSwapResult = {
  readonly operation_id: string;
  readonly result_generation: number;
  readonly result_device: string;
  readonly result_inode: string;
  readonly old_fd_count: number;
};

const SIDECARS = ["-wal", "-shm", "-journal"] as const;

/**
 * Whether any other connection still holds this database, asked of SQLite rather than of /proc.
 *
 * Scanning descriptors misses a process of this user whose descriptor table cannot be read, and on
 * a shared account there is always at least one. A writer of this database cannot hide from SQLite
 * the same way: to write it has to take the file's locks, so an exclusive transaction that cannot
 * begin means somebody else is holding it, visible or not. The transaction is rolled back and the
 * connection closed immediately; nothing is written, and no lock is carried into the rename.
 */
function foreignConnectionHolds(path: string): boolean {
  const probe = new Database(path);
  try {
    probe.pragma("busy_timeout = 0");
    probe.exec("BEGIN EXCLUSIVE");
    probe.exec("ROLLBACK");
    return false;
  } catch {
    return true;
  } finally {
    probe.close();
  }
}

/**
 * Descriptors on the source that belong to somebody else.
 *
 * This process's own connection is still open when the question is first asked, and it is not the
 * problem: it is closed a moment later, in order, by the swap itself. Every other holder is one
 * the rename would leave writing into an orphaned inode. Asking it this way keeps the answer
 * useful before anything is closed; a second connection inside this process is not excused by
 * sharing a pid, and the scan that runs after the close catches it while the file is still whole.
 */
function foreignHolders(
  runtime: AuthorityDatabaseRuntime, fence: { readonly device: string; readonly inode: string },
): number {
  return runtime.observeOldInode(BigInt(fence.device), BigInt(fence.inode))
    .holders.filter(holder => holder.pid !== process.pid).length;
}

/**
 * The source as bytes, with any write-ahead log folded into the answer.
 *
 * Between the last question this process can ask its connection and the rename that replaces the
 * file, another writer can still commit. Nothing in SQLite tells us afterwards, but the bytes do:
 * a commit either changes the main file or leaves a log beside it.
 */
function sourceBytes(path: string): string {
  const sidecars = SIDECARS.map(suffix => {
    try { return `${suffix}:${statSync(`${path}${suffix}`).size}`; } catch { return `${suffix}:none`; }
  }).join(",");
  return `sha256:${createHash("sha256").update(readFileSync(path)).digest("hex")}|${sidecars}`;
}

/**
 * Makes a verified candidate the live authority database.
 *
 * The caller holds the runtime quiesce lease, as for a compaction swap. Three things are proved
 * before anything moves: this operation owns the candidate, the source has not changed since the
 * candidate was built from it, and the candidate carries the generation the build produced. The
 * second is the one that matters for data: a candidate is a copy of a snapshot, so applying it
 * over a source that has moved on would discard whatever arrived in between.
 */
export function applyRetentionCandidate(
  runtime: AuthorityDatabaseRuntime, application: LocalObservationRetentionApplication, now: Date,
): RetentionSwapResult {
  const authority = runtime.authorityDb();
  const { operation, build, source_fence: fence } = application;
  assertRetentionOperationOwned(authority, operation);
  // Identity survives a rewrite, so the bytes are checked against what verification saw.
  assertCandidateUnchanged(authority, operation);
  const candidate = statSync(operation.candidate_path, { bigint: true });
  const result = { device: candidate.dev.toString(), inode: candidate.ino.toString() };
  // Checkpointed first, then asked: everything committed by any connection is in the main file
  // before the question is put, so a write that arrived while the candidate was being verified is
  // seen here rather than discarded by the rename.
  authority.db.pragma("wal_checkpoint(TRUNCATE)");
  if (retentionSourceMoved(authority, fence)) {
    throw new JarvisError("LOCAL_RETENTION_SOURCE_CHANGED");
  }
  // Published while the source connection is still open, which is the order that makes the two
  // halves meet: from here a cooperating process cannot be admitted, so the scan below sees every
  // connection that will ever exist against this file, and it runs before anything is closed,
  // written or moved.
  publishSwapBarrier(authority.filename, "local_retention", now);
  let observed;
  try {
    // A descriptor on the source held by another process belongs to a writer the rename would
    // orphan: its commits would land in an inode nothing reads again. There is no way to take that
    // descriptor away, so the swap is refused while the source is still the live database - with
    // this connection still open, the candidate untouched and the operation exactly as
    // verification left it. That is what makes the refusal retryable rather than a rebuild thrown
    // away: closing the connection would reset the row counter the caller's fence is stated in,
    // and the same fence has to still describe this connection when the caller tries again.
    if (foreignHolders(runtime, fence) !== 0) {
      throw new JarvisError("LOCAL_RETENTION_SOURCE_WRITER_ACTIVE");
    }
    authority.close();
    // Asked again now that this process's own connection is gone, so the answer covers every
    // holder rather than every other holder - a second connection inside this process is not
    // excused by sharing a pid. Nothing has been removed yet, which is the point: a write-ahead
    // log deleted beside a connection that is still open would take committed rows with it, so
    // exclusion is proved first and the file is touched second.
    const closed = runtime.observeOldInode(BigInt(fence.device), BigInt(fence.inode));
    if (closed.fd_count !== 0) {
      throw new JarvisError("LOCAL_RETENTION_SOURCE_WRITER_ACTIVE");
    }
    // The last question before anything is removed, and the only one a writer cannot evade by
    // being invisible to /proc: if another connection holds this database, it holds its locks.
    if (foreignConnectionHolds(authority.filename)) {
      throw new JarvisError("LOCAL_RETENTION_SOURCE_WRITER_ACTIVE");
    }
    // Nothing has been removed yet, which is where this belongs: a database another user may
    // write is not proved exclusive by any answer this process can get, so it refuses instead of
    // destroying the log on an answer that does not cover that writer.
    const hole = exclusionHole(authority.filename,
      runtime.observeExclusion(BigInt(fence.device), BigInt(fence.inode)));
    if (hole !== null) {
      throw new JarvisError("LOCAL_RETENTION_EXCLUSION_UNPROVABLE",
        `LOCAL_RETENTION_EXCLUSION_UNPROVABLE: ${hole}`);
    }
    // Named here, moved after the publish. The log beside the live name belongs to the inode that
    // is about to be retired, and moving it before the publish would leave a writer that arrives
    // in between writing a log the published database would then be handed - which SQLite reads as
    // a malformed image. Retired afterwards, it pairs with the database it actually belongs to.
    const retired = `${authority.filename}.${operation.operation_id.replace(/^retention:/, "")}`;
    // The baseline for the last question, taken once the connection is gone and its log has been
    // folded in: the file the rename would replace, rather than that file plus a log that closing
    // was about to remove.
    const settled = sourceBytes(authority.filename);
    // Written only once the swap is certain to be attempted. It is the last write before the
    // rename, so it still survives into the live database.
    recordAppliedRetentionOperation(
      operation.candidate_path, operation, result, build.result_generation, now);
    // Asked across the one interval that is left - the applied record being written. Every
    // cooperating connection is excluded or gone by now, so a change here is a writer that never
    // asked, and the rename would discard whatever it just committed.
    if (sourceBytes(authority.filename) !== settled) {
      throw new JarvisError("LOCAL_RETENTION_SOURCE_CHANGED");
    }
    // The interval the probe cannot cover is the one this closes: a connection opened after the
    // earlier questions still holds the file the rename is about to unlink, and an idle one
    // changes no bytes to give itself away. Asked last, so the only window left is the syscall.
    if (runtime.observeOldInode(BigInt(fence.device), BigInt(fence.inode)).fd_count !== 0
      || foreignConnectionHolds(authority.filename)) {
      throw new JarvisError("LOCAL_RETENTION_SOURCE_WRITER_ACTIVE");
    }
    // The retired name is a second link to the live inode, taken before anything moves: the inode
    // keeps a directory entry no matter what happens next, and the live path never stops existing,
    // because publishing is a single atomic rename over it rather than a move away and a move back.
    // A descriptor opened after the last question therefore writes into a file that is still
    // reachable, and a process that dies between these two calls leaves the original database live.
    linkSync(authority.filename, `${retired}.retired`);
    renameSync(operation.candidate_path, authority.filename);
    // The published candidate was checkpointed and has no log of its own, so anything under these
    // names is the retired inode's - including a log a writer created after the last question.
    // Moved while the barrier still stands, so no admitted connection can see the live name with a
    // log that is not its own.
    for (const suffix of SIDECARS) {
      const sidecar = `${authority.filename}${suffix}`;
      if (existsSync(sidecar)) renameSync(sidecar, `${retired}.retired${suffix}`);
    }
    syncPath(dirname(authority.filename), true);
    observed = runtime.observeOldInode(BigInt(fence.device), BigInt(fence.inode));
  } catch (error) {
    // Unwinding. The connection has to come back and the barrier has to go, but neither may
    // replace the reason this failed: that reason is what the caller acts on, and both of these
    // are recoverable without it - a connection that will not reopen stays observably closed, and
    // a barrier this process still holds lapses when this process does.
    try { if (!authority.db.open) authority.reopen(); }
    catch { /* preserved below: the swap's own error is the report */ }
    try { releaseSwapBarrier(authority.filename); }
    catch { /* preserved below: the swap's own error is the report */ }
    throw error;
  }
  // Reopened while this process still holds the barrier, which admits its own owner, so the live
  // connection is back before anybody else is let in. Both happen whatever the rest of this
  // function does, because a barrier left standing would refuse every future open.
  try {
    if (!authority.db.open) authority.reopen();
  } finally {
    releaseSwapBarrier(authority.filename);
  }
  runtime.acknowledgeGeneration(build.result_generation);
  const live = statSync(authority.filename, { bigint: true });
  if (live.dev.toString() !== result.device || live.ino.toString() !== result.inode) {
    throw new JarvisError("LOCAL_RETENTION_SWAP_RESULT_INVALID");
  }
  if (observed.fd_count !== 0) throw new JarvisError("LOCAL_RETENTION_OLD_DATABASE_FD_ACTIVE");
  // The candidate has become the live database, so the directory that held it is empty and ours.
  releaseRetentionOperationDirectory(operation.candidate_path);
  return {
    operation_id: operation.operation_id,
    result_generation: build.result_generation,
    result_device: result.device,
    result_inode: result.inode,
    old_fd_count: observed.fd_count,
  };
}
