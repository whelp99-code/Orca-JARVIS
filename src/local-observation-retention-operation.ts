import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import Database from "better-sqlite3";
import { canonicalize } from "./canonical.js";
import type { AuthorityDb } from "./db.js";
import { JarvisError } from "./jarvis-error.js";
import type { RetentionProjection } from "./local-observation-retention-selection.js";
import { syncPath } from "./memory-authority-swap.js";

const SIDECARS = ["-wal", "-shm", "-journal"] as const;

export type RetentionClaim = {
  readonly claim_device: string;
  readonly claim_inode: string;
  readonly claim_birthtime: string;
};

export type RetentionSnapshotClaim = {
  readonly snapshot_device: string;
  readonly snapshot_inode: string;
  readonly snapshot_birthtime: string;
};

export type RetentionOperation = RetentionClaim & RetentionSnapshotClaim & {
  readonly recorded_changes: number;
  readonly operation_id: string;
  readonly source_device: string;
  readonly source_inode: string;
  readonly owner_token: string;
  readonly candidate_path: string;
  readonly source_generation: number;
  readonly result_generation: number;
  readonly selection_digest: string;
};

export type RetentionRecovery = {
  readonly operation_id: string;
  readonly candidate_path: string;
  readonly outcome: "removed" | "retained_unproven" | "already_gone";
};

/**
 * Rows this connection wrote, measured around the write.
 *
 * The caller fences the source on `total_changes()`, which counts this connection's own rows, so
 * every write here would read as somebody else's change unless it is measured and handed back.
 * Nothing on this thread can interleave a synchronous write, so the delta is exactly these rows.
 */
function rowsWritten(source: AuthorityDb, write: () => void): number {
  const counter = source.db.prepare("SELECT total_changes()").pluck();
  const before = Number(counter.get());
  write();
  return Number(counter.get()) - before;
}

const digest = (value: unknown): string =>
  `sha256:${createHash("sha256").update(canonicalize(value)).digest("hex")}`;

const ACTIVE_GENERATION =
  "SELECT generation FROM memory_database_generations WHERE state='active'";

export function activeGeneration(source: AuthorityDb): number {
  const value = source.db.prepare(ACTIVE_GENERATION).pluck().get();
  if (typeof value !== "number") throw new JarvisError("LOCAL_RETENTION_SOURCE_GENERATION_INVALID");
  return value;
}

/**
 * Whether the file at the claimed path is still the one the claim created.
 *
 * The exclusive create is what makes the path this operation's; the file it produced is what keeps
 * saying so afterwards. A freed inode number can be handed out to the next file, so the birth time
 * is checked with it: writes do not change it and user space cannot set it, which leaves no way to
 * present another file as this one.
 */
export function candidateStillClaimed(candidatePath: string, claim: RetentionClaim): boolean {
  return stillClaimed(candidatePath, claim.claim_device, claim.claim_inode, claim.claim_birthtime);
}

/** The same proof for the snapshot the operation copied from. */
export function snapshotStillClaimed(
  snapshotPath: string, claim: Partial<RetentionSnapshotClaim>,
): boolean {
  return claim.snapshot_device !== undefined && claim.snapshot_inode !== undefined
    && claim.snapshot_birthtime !== undefined
    && stillClaimed(snapshotPath, claim.snapshot_device, claim.snapshot_inode,
      claim.snapshot_birthtime);
}

function stillClaimed(path: string, device: string, inode: string, birthtime: string): boolean {
  try {
    const present = statSync(path, { bigint: true });
    return present.dev.toString() === device && present.ino.toString() === inode
      && present.birthtimeNs.toString() === birthtime;
  } catch {
    return false;
  }
}

/**
 * Records the rebuild before it produces anything, so an interrupted run is explainable.
 *
 * The row names the source this selection read - device, inode and active generation - the digest
 * of the selection itself, and the exact path claimed for the candidate. A later run reads it to
 * tell its own abandoned work from a file it cannot account for.
 */
export function beginRetentionOperation(
  source: AuthorityDb, candidatePath: string, snapshotPath: string,
  blocked: readonly RetentionProjection[], now: Date,
): RetentionOperation {
  const identity = statSync(source.filename, { bigint: true });
  const claim = statSync(candidatePath, { bigint: true });
  const snapshot = statSync(snapshotPath, { bigint: true });
  const generation = activeGeneration(source);
  const operation = {
    recorded_changes: 0,
    claim_device: claim.dev.toString(),
    claim_inode: claim.ino.toString(),
    claim_birthtime: claim.birthtimeNs.toString(),
    snapshot_device: snapshot.dev.toString(),
    snapshot_inode: snapshot.ino.toString(),
    snapshot_birthtime: snapshot.birthtimeNs.toString(),
    operation_id: `retention:${randomUUID()}`,
    source_device: identity.dev.toString(),
    source_inode: identity.ino.toString(),
    owner_token: `${process.pid}:${randomUUID()}`,
    candidate_path: candidatePath,
    source_generation: generation,
    result_generation: generation + 1,
    selection_digest: digest(blocked),
  };
  const at = now.toISOString();
  const recorded = rowsWritten(source, () => { source.db.prepare(
    `INSERT INTO local_retention_operations(operation_id,owner_token,source_device,source_inode,
      source_generation,result_generation,selection_digest,candidate_path,claim_device,claim_inode,
      claim_birthtime,snapshot_device,snapshot_inode,snapshot_birthtime,
      state,failure_code,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,'preparing',NULL,?,?)`,
  ).run(operation.operation_id, operation.owner_token, operation.source_device,
    operation.source_inode, operation.source_generation, operation.result_generation,
    operation.selection_digest, candidatePath, operation.claim_device, operation.claim_inode,
    operation.claim_birthtime, operation.snapshot_device, operation.snapshot_inode,
    operation.snapshot_birthtime, at, at); });
  return { ...operation, recorded_changes: recorded };
}

/** Records the verdict and reports the rows written, which the caller's fence must absorb. */
export function markRetentionOperationVerified(
  source: AuthorityDb, operation: RetentionOperation, now: Date,
): number {
  const digest = candidateDigest(operation.candidate_path);
  return rowsWritten(source, () => { source.db.prepare(
    `UPDATE local_retention_operations SET state='verified',verified_digest=?,updated_at=?
     WHERE operation_id=?`)
    .run(digest, now.toISOString(), operation.operation_id); });
}

/**
 * The bytes of a candidate that is not open anywhere.
 *
 * A write-ahead log beside it means rows exist that the main file does not carry, so the file this
 * digest covers would not be the file that goes live. Both the verification and the installation
 * read this, and they must agree.
 */
export function candidateDigest(candidatePath: string): string {
  for (const suffix of SIDECARS) {
    if (existsSync(`${candidatePath}${suffix}`)) {
      throw new JarvisError("LOCAL_RETENTION_CANDIDATE_MODIFIED");
    }
  }
  return `sha256:${createHash("sha256").update(readFileSync(candidatePath)).digest("hex")}`;
}

/** Refuses a candidate whose bytes are not the bytes that were verified. */
export function assertCandidateUnchanged(source: AuthorityDb, operation: RetentionOperation): void {
  const recorded = source.db.prepare(
    "SELECT verified_digest FROM local_retention_operations WHERE operation_id=?")
    .pluck().get(operation.operation_id);
  if (typeof recorded !== "string" || recorded !== candidateDigest(operation.candidate_path)) {
    throw new JarvisError("LOCAL_RETENTION_CANDIDATE_MODIFIED");
  }
}

/** Records why the attempt ended and removes only the artefacts this operation created. */
export function abandonRetentionOperation(
  source: AuthorityDb, operation: RetentionOperation, failureCode: string, now: Date,
): void {
  try {
    source.db.prepare(
      `UPDATE local_retention_operations SET state='abandoned',failure_code=?,updated_at=?
       WHERE operation_id=? AND state IN ('preparing','verified')`,
    ).run(failureCode.slice(0, 128), now.toISOString(), operation.operation_id);
  } catch {
    // The record is evidence, not a lock: a failure to write it must not hide the original error.
  }
  releaseRetentionCandidate(operation.candidate_path);
}

/**
 * Removes an artifact this operation can still prove is its own, by moving it first.
 *
 * Checking a pathname and then deleting that pathname are two operations, and between them the
 * file can be replaced; the deletion would then fall on somebody else's file. Renaming is atomic,
 * so the object that moves is the object that gets inspected and unlinked. A file that turns out
 * not to be ours is put back and left alone.
 *
 * The sidecars are removed by name. The path is claimed exclusively for this operation and never
 * handed out, so the names beside it are this operation's namespace; giving each sidecar its own
 * recorded identity, or isolating every artifact in an operation-owned directory, is the stronger
 * form and is recorded as follow-up rather than implied here.
 */
export function releaseProvenArtifact(path: string, proven: (moved: string) => boolean): boolean {
  const moving = `${path}.releasing`;
  try {
    renameSync(path, moving);
  } catch {
    return false;
  }
  if (!proven(moving)) {
    try { renameSync(moving, path); } catch { /* left under the moved name rather than deleted */ }
    return false;
  }
  for (const suffix of SIDECARS) rmSync(`${path}${suffix}`, { force: true });
  rmSync(moving, { force: true });
  return true;
}

/** Removes the candidate and its sidecars. Callers own that path. */
export function releaseRetentionCandidate(candidatePath: string): void {
  for (const suffix of SIDECARS) rmSync(`${candidatePath}${suffix}`, { force: true });
  rmSync(candidatePath, { force: true });
}

/** Proof that this operation, and not merely something at that path, owns the candidate. */
export function assertRetentionOperationOwned(
  source: AuthorityDb, operation: RetentionOperation,
): void {
  const row = source.db.prepare(
    `SELECT owner_token,state,candidate_path,claim_device,claim_inode
     ,claim_birthtime FROM local_retention_operations WHERE operation_id=?`)
    .get(operation.operation_id);
  const field = (name: string): unknown =>
    row === null || typeof row !== "object" ? undefined : Reflect.get(row, name);
  if (field("owner_token") !== operation.owner_token || field("state") !== "verified"
    || field("candidate_path") !== operation.candidate_path
    || field("claim_device") !== operation.claim_device
    || field("claim_inode") !== operation.claim_inode
    || field("claim_birthtime") !== operation.claim_birthtime
    || !candidateStillClaimed(operation.candidate_path, operation)) {
    throw new JarvisError("LOCAL_RETENTION_SWAP_UNOWNED");
  }
}

/**
 * Writes the applied record into the candidate itself, before it becomes the live database.
 *
 * The rename destroys the database holding the 'verified' row, so a record written after it would
 * be missing for exactly the window a crash is most likely to fall in. The rename keeps the inode,
 * so the identity recorded here is the identity the live file will have. The candidate is
 * checkpointed and its sidecars removed first: only the main file is renamed, so a row left in a
 * write-ahead log beside it would not survive the swap.
 */
export function recordAppliedRetentionOperation(
  candidatePath: string, operation: RetentionOperation,
  result: { readonly device: string; readonly inode: string },
  expectedGeneration: number, now: Date,
): void {
  const candidate = new Database(candidatePath);
  try {
    if (candidate.prepare(ACTIVE_GENERATION).pluck().get() !== expectedGeneration) {
      throw new JarvisError("LOCAL_RETENTION_CANDIDATE_GENERATION_INVALID");
    }
    const identity = statSync(candidatePath, { bigint: true });
    if (identity.dev.toString() !== result.device || identity.ino.toString() !== result.inode) {
      throw new JarvisError("LOCAL_RETENTION_CANDIDATE_IDENTITY_MISMATCH");
    }
    const at = now.toISOString();
    candidate.prepare(
      `INSERT INTO local_retention_operations(operation_id,owner_token,source_device,source_inode,
        source_generation,result_generation,selection_digest,candidate_path,claim_device,
        claim_inode,claim_birthtime,state,failure_code,result_device,result_inode,created_at,
        updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,'applied',NULL,?,?,?,?)`,
    ).run(operation.operation_id, operation.owner_token, operation.source_device,
      operation.source_inode, operation.source_generation, operation.result_generation,
      operation.selection_digest, candidatePath, operation.claim_device, operation.claim_inode,
      operation.claim_birthtime, result.device, result.inode, at, at);
    candidate.pragma("wal_checkpoint(TRUNCATE)");
  } finally {
    candidate.close();
  }
  for (const suffix of SIDECARS) rmSync(`${candidatePath}${suffix}`, { force: true });
  syncPath(candidatePath);
}
