import { createHash } from "node:crypto";
import { readFileSync, renameSync, rmSync, statSync } from "node:fs";
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
 * Descriptors on the source that belong to somebody else.
 *
 * This process's own connection is still open when the question is first asked, and it is not the
 * problem: it is closed a moment later, in order, by the swap itself. Every other holder is one
 * the rename would leave writing into an orphaned inode.
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
    for (const suffix of SIDECARS) rmSync(`${authority.filename}${suffix}`, { force: true });
    // Asked again now that this process's own connection is gone, so the answer covers every
    // holder rather than every other holder: the rename proceeds only against a file nobody has
    // open at all.
    if (runtime.observeOldInode(BigInt(fence.device), BigInt(fence.inode)).fd_count !== 0) {
      throw new JarvisError("LOCAL_RETENTION_SOURCE_WRITER_ACTIVE");
    }
    // Written only once the swap is certain to be attempted. It is the last write before the
    // rename, so it still survives into the live database.
    recordAppliedRetentionOperation(
      operation.candidate_path, operation, result, build.result_generation, now);
    // Taken once the connection is gone and its log is folded in, so the baseline is the file the
    // rename would replace rather than the file plus a log that closing was about to remove.
    const settled = sourceBytes(authority.filename);
    // The connection is gone and no other holder remains, so the last word on whether anybody
    // wrote in the remaining moments is the file itself: identical bytes and no log beside it.
    if (sourceBytes(authority.filename) !== settled) {
      throw new JarvisError("LOCAL_RETENTION_SOURCE_CHANGED");
    }
    renameSync(operation.candidate_path, authority.filename);
    syncPath(dirname(authority.filename), true);
    observed = runtime.observeOldInode(BigInt(fence.device), BigInt(fence.inode));
  } catch (error) {
    releaseSwapBarrier(authority.filename);
    if (!authority.db.open) authority.reopen();
    throw error;
  }
  // Reopened while this process still holds the barrier, which admits its own owner, so the live
  // connection is back before anybody else is let in.
  authority.reopen();
  releaseSwapBarrier(authority.filename);
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
