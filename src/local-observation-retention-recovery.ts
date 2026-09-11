import { existsSync, rmSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { processStartToken } from "./authority-database-process.js";
import type { AuthorityDb } from "./db.js";
import {
  activeGeneration, candidateStillClaimed,
  type RetentionClaim, type RetentionSnapshotClaim,
} from "./local-observation-retention-operation.js";
import { removeProvenDirectory } from "./local-observation-retention-artifacts.js";
import { stagedClaimPath } from "./local-observation-retention-claim.js";

export type RetentionRecovery = {
  readonly operation_id: string;
  readonly recorded_state: "preparing" | "verified";
  readonly candidate_path: string;
  readonly outcome: "removed_partial" | "removed_unapplied" | "retained_unproven" | "already_gone"
    | "retained_active";
};

type UnfinishedRow = RetentionClaim & Partial<RetentionSnapshotClaim> & {
  readonly operation_id: string;
  readonly owner_token: string;
  readonly candidate_path: string;
  readonly state: "preparing" | "verified";
  readonly source_device: string;
  readonly source_inode: string;
  readonly source_generation: number;
  readonly owner_start_token: string | null;
};

/**
 * Cleans up after a process that died mid-rebuild.
 *
 * A candidate is removed only when an operation row claims that exact path and the file there is
 * still the inode that row's claim created. A file that is anything else is left where it is and
 * reported as `retained_unproven`: reusing a name is not evidence of ownership, and the exclusive
 * destination claim keeps refusing the path until an operator decides what that file is.
 *
 * A verified candidate is removed rather than applied. It is a copy of a snapshot that was proved
 * correct by a process that is gone, and re-proving it needs that snapshot, which is gone too;
 * since the source it came from is untouched, discarding it costs a rebuild and risks nothing.
 * That removal is allowed only while the live source is still the file the row selected from - same
 * device, inode and generation - because a source that moved on may already be the applied result.
 */
export function recoverLocalRetentionOperations(
  source: AuthorityDb, now: Date,
): readonly RetentionRecovery[] {
  const live = statSync(source.filename, { bigint: true });
  const generation = activeGeneration(source);
  const unchanged = (row: UnfinishedRow): boolean =>
    row.source_device === live.dev.toString() && row.source_inode === live.ino.toString()
    && row.source_generation === generation;
  const recovered: RetentionRecovery[] = [];
  for (const row of unfinishedRows(source)) {
    // Recovery runs before the schedule window, so it can meet an operation whose process is still
    // building. The row says `preparing` either way; only the owner being gone separates them.
    if (ownerLiveness(row) !== "dead") {
      recovered.push({ operation_id: row.operation_id, recorded_state: row.state,
        candidate_path: row.candidate_path, outcome: "retained_active" });
      continue;
    }
    const present = existsSync(row.candidate_path);
    const proven = candidateStillClaimed(row.candidate_path, row);
    const report = (outcome: RetentionRecovery["outcome"]): void => {
      recovered.push({ operation_id: row.operation_id, recorded_state: row.state,
        candidate_path: row.candidate_path, outcome });
    };
    if (!present) {
      abandon(source, row.operation_id, "LOCAL_RETENTION_RECOVERED_MISSING", now);
      report("already_gone");
      continue;
    }
    if (!proven || (row.state === "verified" && !unchanged(row))) {
      report("retained_unproven");
      continue;
    }
    // The candidate proves the directory is this operation's, and the directory is everything it
    // owns, so one removal takes the candidate, the snapshot and every sidecar with it.
    // The identity above proved the candidate; the directory is removed by moving it aside and
    // re-checking what moved, so a path another run has since taken is not destroyed by this one.
    // The operation row's identity describes the candidate file, so the proof after the move is
    // that file inside the directory that moved - not the directory, which was never what was
    // recorded.
    if (!removeProvenDirectory(dirname(row.candidate_path),
      { device: row.claim_device, inode: row.claim_inode, birthtime: row.claim_birthtime,
        entry: basename(row.candidate_path) },
      row.operation_id)) {
      report("retained_unproven");
      continue;
    }
    abandon(source, row.operation_id, row.state === "verified"
      ? "LOCAL_RETENTION_RECOVERED_UNAPPLIED" : "LOCAL_RETENTION_RECOVERED_PARTIAL", now);
    report(row.state === "verified" ? "removed_unapplied" : "removed_partial");
  }
  recovered.push(...recoverUnrecordedClaims(source, now));
  return recovered;
}

/**
 * Directories a run announced but never got as far as recording an operation for.
 *
 * The intent names the path and the process that meant to create it. If that process is still
 * running the claim is live work, not debris. If it is gone, the directory is this lane's own
 * abandoned work: it was created by the run that wrote the intent and nothing else ever writes
 * there, so removing it is removing our own, and the intent goes with it.
 */
function recoverUnrecordedClaims(source: AuthorityDb, now: Date): readonly RetentionRecovery[] {
  void now;
  const rows = source.db.prepare(
    `SELECT i.operation_id AS operation_id,i.owner_token AS owner_token,
       i.owner_start_token AS owner_start_token,i.directory AS directory,
       i.claim_device AS claim_device,i.claim_inode AS claim_inode,
       i.claim_birthtime AS claim_birthtime
     FROM local_retention_claim_intents i
     WHERE NOT EXISTS (SELECT 1 FROM local_retention_operations o
       WHERE o.operation_id=i.operation_id)
     ORDER BY i.created_at,i.operation_id`).all();
  const recovered: RetentionRecovery[] = [];
  for (const value of rows) {
    if (value === null || typeof value !== "object") continue;
    const text = (name: string): string | null =>
      typeof Reflect.get(value, name) === "string" ? String(Reflect.get(value, name)) : null;
    const directory = String(Reflect.get(value, "directory"));
    const operationId = String(Reflect.get(value, "operation_id"));
    const report = (outcome: RetentionRecovery["outcome"]): void => {
      recovered.push({ operation_id: operationId, recorded_state: "preparing",
        candidate_path: join(directory, "candidate.sqlite"), outcome });
    };
    const clear = (): void => {
      source.db.prepare("DELETE FROM local_retention_claim_intents WHERE operation_id=?")
        .run(operationId);
    };
    // Not dead is not the same as dead: a process we cannot read is one we must not assume about.
    if (ownerLiveness({ owner_token: String(Reflect.get(value, "owner_token")),
      owner_start_token: text("owner_start_token") }) !== "dead") {
      report("retained_active");
      continue;
    }
    const claim = { claim_device: text("claim_device"), claim_inode: text("claim_inode"),
      claim_birthtime: text("claim_birthtime") };
    if (!existsSync(directory)) {
      // The destination is only ever taken by renaming a staged claim onto it, so a run that died
      // before that rename left nothing at the destination and the name is free again whatever
      // happens next. Its work, if any, is under a name derived from this intent.
      const staged = stagedClaimPath(directory, operationId);
      if (!existsSync(staged)) {
        clear();
        report("already_gone");
        continue;
      }
      // Whether that object is ours is decided by the identity recorded for it, not by the name.
      // A name this run chose is not a claim on whatever is wearing it now, which is the same rule
      // that keeps recovery off a destination it cannot account for. Unproven, it stays exactly
      // where it is and is reported; the intent still goes, because the destination it was holding
      // was never taken and nothing is served by refusing that path to every later run.
      if (claim.claim_device === null || !directoryStillClaimed(staged, claim)) {
        clear();
        report("retained_unproven");
        continue;
      }
      // Proved, but the proof and the removal are two acts: the object is moved aside first and
      // re-checked under the name it actually moved to, so a path that changed owner in between
      // cannot be destroyed by this call.
      const removed = removeProvenDirectory(staged, { device: String(claim.claim_device),
        inode: String(claim.claim_inode), birthtime: String(claim.claim_birthtime) }, operationId);
      clear();
      report(removed ? "removed_partial" : "retained_unproven");
      continue;
    }
    // An intent without a recorded identity says only that this run meant to create the path. What
    // is there now may be anybody's, so it stays and is reported.
    if (claim.claim_device === null || !directoryStillClaimed(directory, claim)) {
      report("retained_unproven");
      continue;
    }
    rmSync(directory, { recursive: true, force: true });
    clear();
    report("removed_partial");
  }
  return recovered;
}

/** The directory this intent created, still carrying the identity the create produced. */
function directoryStillClaimed(directory: string, claim: {
  readonly claim_device: string | null; readonly claim_inode: string | null;
  readonly claim_birthtime: string | null;
}): boolean {
  try {
    const present = statSync(directory, { bigint: true });
    return present.dev.toString() === claim.claim_device
      && present.ino.toString() === claim.claim_inode
      && present.birthtimeNs.toString() === claim.claim_birthtime;
  } catch {
    return false;
  }
}

/**
 * True while the process that recorded this operation is still the one running under that pid.
 *
 * Pids are reused, so the recorded start time decides: a different token means a different process
 * wearing the same number, and no token at all means a row written before this was recorded, which
 * is treated as no live owner exactly as it was before.
 */
function ownerLiveness(row: {
  readonly owner_token: string; readonly owner_start_token: string | null;
}): "alive" | "dead" | "unknown" {
  const pid = Number.parseInt(row.owner_token.split(":")[0] ?? "", 10);
  // No token, an unreadable pid, or this very process: none of these prove the owner is gone, and
  // an apply running in this process right now wears this pid.
  if (row.owner_start_token === null || !Number.isSafeInteger(pid) || pid < 1) return "unknown";
  if (pid === process.pid) return "alive";
  try {
    return processStartToken(pid) === row.owner_start_token ? "alive" : "dead";
  } catch {
    // No entry under /proc means no such process. A read that failed for any other reason is a
    // question this cannot answer, and an unanswered question is not permission to delete.
    return existsSync(`/proc/${pid}`) ? "unknown" : "dead";
  }
}

function unfinishedRows(source: AuthorityDb): readonly UnfinishedRow[] {
  const rows = source.db.prepare(
    `SELECT operation_id,owner_token,candidate_path,state,source_device,source_inode,
       source_generation,owner_start_token,claim_device,claim_inode,claim_birthtime,
       snapshot_device,snapshot_inode,snapshot_birthtime FROM local_retention_operations
     WHERE state IN ('preparing','verified') ORDER BY created_at,operation_id`).all();
  return rows.flatMap(row => row === null || typeof row !== "object" ? []
    : [{
      operation_id: String(Reflect.get(row, "operation_id")),
      owner_token: String(Reflect.get(row, "owner_token")),
      candidate_path: String(Reflect.get(row, "candidate_path")),
      state: Reflect.get(row, "state") as UnfinishedRow["state"],
      source_device: String(Reflect.get(row, "source_device")),
      source_inode: String(Reflect.get(row, "source_inode")),
      source_generation: Number(Reflect.get(row, "source_generation")),
      owner_start_token: typeof Reflect.get(row, "owner_start_token") === "string"
        ? String(Reflect.get(row, "owner_start_token")) : null,
      claim_device: String(Reflect.get(row, "claim_device")),
      claim_inode: String(Reflect.get(row, "claim_inode")),
      claim_birthtime: String(Reflect.get(row, "claim_birthtime")),
      ...text(row, "snapshot_device"), ...text(row, "snapshot_inode"),
      ...text(row, "snapshot_birthtime"),
    }]);
}

/** Present only when the operation recorded it; older rows have none. */
function text(row: object, name: string): Record<string, string> {
  const value = Reflect.get(row, name);
  return typeof value === "string" ? { [name]: value } : {};
}

function abandon(source: AuthorityDb, operationId: string, failureCode: string, now: Date): void {
  source.db.prepare(
    `UPDATE local_retention_operations SET state='abandoned',failure_code=?,updated_at=?
     WHERE operation_id=? AND state IN ('preparing','verified')`)
    .run(failureCode, now.toISOString(), operationId);
}
