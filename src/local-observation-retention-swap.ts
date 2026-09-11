import { createHash } from "node:crypto";
import { readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { dirname } from "node:path";
import type { AuthorityDatabaseRuntime } from "./authority-database-runtime.js";
import { JarvisError } from "./jarvis-error.js";
import {
  assertCandidateUnchanged, assertRetentionOperationOwned, recordAppliedRetentionOperation,
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
  recordAppliedRetentionOperation(
    operation.candidate_path, operation, result, build.result_generation, now);
  authority.close();
  for (const suffix of SIDECARS) rmSync(`${authority.filename}${suffix}`, { force: true });
  // Taken once the connection is gone and its log is folded in, so the baseline is the file the
  // rename would replace rather than the file plus a log that closing was about to remove.
  const settled = sourceBytes(authority.filename);
  let observed;
  try {
    // The connection is gone, so the last word on whether anybody wrote in the remaining moments
    // is the file itself: identical bytes and no write-ahead log beside it.
    if (sourceBytes(authority.filename) !== settled) {
      throw new JarvisError("LOCAL_RETENTION_SOURCE_CHANGED");
    }
    renameSync(operation.candidate_path, authority.filename);
    syncPath(dirname(authority.filename), true);
    observed = runtime.observeOldInode(BigInt(fence.device), BigInt(fence.inode));
  } catch (error) {
    authority.reopen();
    throw error;
  }
  authority.reopen();
  runtime.acknowledgeGeneration(build.result_generation);
  const live = statSync(authority.filename, { bigint: true });
  if (live.dev.toString() !== result.device || live.ino.toString() !== result.inode) {
    throw new JarvisError("LOCAL_RETENTION_SWAP_RESULT_INVALID");
  }
  if (observed.fd_count !== 0) throw new JarvisError("LOCAL_RETENTION_OLD_DATABASE_FD_ACTIVE");
  return {
    operation_id: operation.operation_id,
    result_generation: build.result_generation,
    result_device: result.device,
    result_inode: result.inode,
    old_fd_count: observed.fd_count,
  };
}
