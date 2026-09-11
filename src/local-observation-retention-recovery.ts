import { existsSync, statSync } from "node:fs";
import { processStartToken } from "./authority-database-process.js";
import type { AuthorityDb } from "./db.js";
import {
  activeGeneration, candidateStillClaimed, releaseProvenArtifact, snapshotStillClaimed,
  type RetentionClaim, type RetentionSnapshotClaim,
} from "./local-observation-retention-operation.js";

/** Matches the path the apply derives for the snapshot it copies from. */
const SNAPSHOT_SUFFIX = ".selected-source";

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
    if (ownerAlive(row)) {
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
    // Moved, then proved, then unlinked: a replacement that arrives after the check above is not
    // what gets deleted.
    if (!releaseProvenArtifact(row.candidate_path, moved => candidateStillClaimed(moved, row))) {
      report("retained_unproven");
      continue;
    }
    // The snapshot beside it goes on the same proof, with its sidecars: a write-ahead log left
    // next to a removed database still occupies the name the retry has to claim.
    const snapshotPath = `${row.candidate_path}${SNAPSHOT_SUFFIX}`;
    releaseProvenArtifact(snapshotPath, moved => snapshotStillClaimed(moved, row));
    abandon(source, row.operation_id, row.state === "verified"
      ? "LOCAL_RETENTION_RECOVERED_UNAPPLIED" : "LOCAL_RETENTION_RECOVERED_PARTIAL", now);
    report(row.state === "verified" ? "removed_unapplied" : "removed_partial");
  }
  return recovered;
}

/**
 * True while the process that recorded this operation is still the one running under that pid.
 *
 * Pids are reused, so the recorded start time decides: a different token means a different process
 * wearing the same number, and no token at all means a row written before this was recorded, which
 * is treated as no live owner exactly as it was before.
 */
function ownerAlive(row: UnfinishedRow): boolean {
  const pid = Number.parseInt(row.owner_token.split(":")[0] ?? "", 10);
  if (row.owner_start_token === null || !Number.isSafeInteger(pid) || pid < 1) return false;
  if (pid === process.pid) return false;
  try {
    return processStartToken(pid) === row.owner_start_token;
  } catch {
    return false;
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
