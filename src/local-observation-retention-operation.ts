import { createHash, randomUUID } from "node:crypto";
import { rmSync, statSync } from "node:fs";
import Database from "better-sqlite3";
import { canonicalize } from "./canonical.js";
import type { AuthorityDb } from "./db.js";
import { JarvisError } from "./jarvis-error.js";
import type { RetentionProjection } from "./local-observation-retention-selection.js";
import { processStartToken } from "./authority-database-process.js";
import { syncPath } from "./memory-authority-swap.js";
import {
  candidateDigest, candidateStillClaimed, releaseRetentionOperationDirectory, SIDECARS,
  type RetentionClaim, type RetentionSnapshotClaim,
} from "./local-observation-retention-artifacts.js";


export type {
  RetentionClaim, RetentionSnapshotClaim,
} from "./local-observation-retention-artifacts.js";
export {
  candidateDigest, candidateStillClaimed, releaseRetentionOperationDirectory, snapshotStillClaimed,
} from "./local-observation-retention-artifacts.js";

export type RetentionOperation = RetentionClaim & RetentionSnapshotClaim & {
  readonly recorded_changes: number;
  readonly owner_start_token: string;
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
 * Announces the path this run is about to create, before it creates it.
 *
 * The operation record needs the claim's identity and the selection's digest, and the selection
 * needs a snapshot that takes as long as a database copy to make. Everything in that window would
 * otherwise be invisible to recovery, which reads rows. The intent is written first and carries
 * the same owner identity, so what is found later can be recognised without trusting a pathname.
 */
export function recordRetentionClaimIntent(
  source: AuthorityDb, directory: string, now: Date,
): { readonly operation_id: string; readonly recorded_changes: number } {
  const operationId = `retention:${randomUUID()}`;
  const recorded = rowsWritten(source, () => { source.db.prepare(
    `INSERT INTO local_retention_claim_intents(operation_id,owner_token,owner_start_token,
      directory,created_at) VALUES(?,?,?,?,?)`,
  ).run(operationId, `${process.pid}:${randomUUID()}`, processStartToken(process.pid), directory,
    now.toISOString()); });
  return { operation_id: operationId, recorded_changes: recorded };
}

/**
 * Records what the exclusive create actually produced, once it has produced it.
 *
 * Between the intent and this call the path may hold something this run did not make - the create
 * may have failed, or never been reached. Recovery reads this identity, so writing it is the
 * moment the claim stops being an intention and becomes a fact.
 */
export function recordRetentionClaimIdentity(
  source: AuthorityDb, operationId: string, directory: string,
): number {
  const claim = statSync(directory, { bigint: true });
  return rowsWritten(source, () => { source.db.prepare(
    `UPDATE local_retention_claim_intents SET claim_device=?,claim_inode=?,claim_birthtime=?
     WHERE operation_id=?`,
  ).run(claim.dev.toString(), claim.ino.toString(), claim.birthtimeNs.toString(), operationId); });
}

/** The intent has served its purpose once the operation it belongs to is recorded or gone. */
export function clearRetentionClaimIntent(source: AuthorityDb, operationId: string): number {
  return rowsWritten(source, () => { source.db.prepare(
    "DELETE FROM local_retention_claim_intents WHERE operation_id=?").run(operationId); });
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
  blocked: readonly RetentionProjection[], now: Date, intentId?: string,
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
    // Carries the intent's id so the announced claim and the recorded work are one thing.
    operation_id: intentId ?? `retention:${randomUUID()}`,
    source_device: identity.dev.toString(),
    source_inode: identity.ino.toString(),
    owner_token: `${process.pid}:${randomUUID()}`,
    owner_start_token: processStartToken(process.pid),
    candidate_path: candidatePath,
    source_generation: generation,
    result_generation: generation + 1,
    selection_digest: digest(blocked),
  };
  const at = now.toISOString();
  const recorded = rowsWritten(source, () => { source.db.prepare(
    `INSERT INTO local_retention_operations(operation_id,owner_token,source_device,source_inode,
      source_generation,result_generation,selection_digest,candidate_path,claim_device,claim_inode,
      claim_birthtime,snapshot_device,snapshot_inode,snapshot_birthtime,owner_start_token,
      state,failure_code,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'preparing',NULL,?,?)`,
  ).run(operation.operation_id, operation.owner_token, operation.source_device,
    operation.source_inode, operation.source_generation, operation.result_generation,
    operation.selection_digest, candidatePath, operation.claim_device, operation.claim_inode,
    operation.claim_birthtime, operation.snapshot_device, operation.snapshot_inode,
    operation.snapshot_birthtime, operation.owner_start_token, at, at); });
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
  releaseRetentionOperationDirectory(operation.candidate_path);
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
