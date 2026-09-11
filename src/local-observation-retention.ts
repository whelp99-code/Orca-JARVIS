import { rmSync } from "node:fs";
import type Database from "better-sqlite3";
import { AuthorityDb } from "./db.js";
import { JarvisError } from "./jarvis-error.js";
import {
  ownWrite, retentionSourceFence, retentionSourceMoved, type RetentionSourceFence,
} from "./local-observation-retention-fence.js";
import {
  assertRetentionCutoff, selectLocalObservationRetention,
  type LocalObservationRetentionSelection, type RetentionProjection,
} from "./local-observation-retention-selection.js";
import {
  assertCandidateMatchesCopyPlan,
} from "./local-observation-retention-candidate.js";
import {
  abandonRetentionOperation, beginRetentionOperation, clearRetentionClaimIntent,
  markRetentionOperationVerified, recordRetentionClaimIdentity, recordRetentionClaimIntent, type RetentionOperation,
} from "./local-observation-retention-operation.js";
import { buildFreshAuthority, type FreshAuthorityBuild } from "./memory-authority-fresh-builder.js";
import {
  claimRetentionOperation, releaseRetentionOperation, resolveRetentionDirectory, stagedClaimPath,
  type RetentionPaths,
} from "./local-observation-retention-claim.js";

export { stagedClaimPath } from "./local-observation-retention-claim.js";
export type { RetentionPaths } from "./local-observation-retention-claim.js";

export type { RetentionSourceFence } from "./local-observation-retention-fence.js";
export { retentionSourceMoved } from "./local-observation-retention-fence.js";

export type LocalObservationRetentionApplication = {
  readonly selection: LocalObservationRetentionSelection;
  readonly build: FreshAuthorityBuild;
  readonly source_fence: RetentionSourceFence;
  readonly operation: RetentionOperation;
};

/**
 * Lists the removed recommendations a notification still addresses.
 *
 * `notification_intents` names a recommendation only inside `deep_link` text, percent-encoded,
 * with no foreign key and no index behind it, so `foreign_key_check` reports a clean candidate
 * while the reference dangles. A hit here means the reference appeared after the selection ran:
 * had it existed earlier, the selector would have retained the group instead of blocking it.
 */
export function findDanglingRetentionReferences(
  database: Database.Database, blocked: readonly RetentionProjection[],
): readonly string[] {
  const addressed = database.prepare(
    "SELECT COUNT(*) FROM notification_intents WHERE deep_link LIKE '%'||?||'%'").pluck();
  return blocked.filter(item => item.kind === "recommendation").map(item => item.id)
    .filter(id => Number(addressed.get(encodeURIComponent(id))) > 0);
}

/**
 * Re-checks that the source has not moved past the fence the candidate was built from. Callers
 * run this immediately before acting on a candidate: it is the only thing standing between a
 * stale rebuild and a source that changed after it was produced.
 */
export function verifyLocalObservationRetentionCandidate(
  source: AuthorityDb, application: LocalObservationRetentionApplication,
): void {
  if (retentionSourceMoved(source, application.source_fence)) {
    throw new JarvisError("LOCAL_RETENTION_SOURCE_CHANGED");
  }
  const dangling = findDanglingRetentionReferences(source.db, application.selection.blocked);
  if (dangling.length !== 0) throw new JarvisError("LOCAL_RETENTION_REFERENCE_DANGLING");
}

/**
 * Applies a cutoff by rebuilding the authority into a destination this call owns exclusively.
 *
 * The candidate is the source as of `source_fence`, and nothing here is a swap. Selection and
 * copy do not share one read transaction - the rebuild adapter copies through its own connection
 * and yields while migrating - so a write landing in that gap would otherwise be copied without
 * being selected. The fence is therefore re-read after the build and any movement rejects the
 * candidate, and the removed recommendations are checked against notification references that no
 * foreign key protects. Callers re-run `verifyLocalObservationRetentionCandidate` immediately
 * before acting on the candidate, because this fence only proves the source held still until here.
 *
 * The source is neither swapped nor deleted, and its logical rows are unchanged; the rebuild
 * adapter does checkpoint the source's write-ahead log, so the source file's bytes can change
 * while `total_changes()` stays equal. A failed or rejected build takes only this call's own
 * destination with it, leaving nothing that could be mistaken for a usable candidate.
 */
/**
 * Copies the database this connection reads into a file this call owns, through SQLite's backup
 * API rather than through the pathname.
 *
 * This is what binds selection and copy to one source. The rebuild adapter attaches a pathname on
 * its own connection, so while the pathname was the source, a replacement timed around that attach
 * - even one undone immediately - produced a candidate built from a file the selection never read,
 * and no endpoint check, counter or row comparison could tell. Reading through the open connection
 * removes the question: the snapshot is the selection's data by construction, and everything after
 * it, including the adapter's own filters, works from that one file.
 */
async function captureSelectedSource(source: AuthorityDb, snapshotPath: string): Promise<AuthorityDb> {
  try {
    await source.db.backup(snapshotPath);
  } catch {
    throw new JarvisError("LOCAL_RETENTION_SOURCE_SNAPSHOT_FAILED");
  }
  return new AuthorityDb(snapshotPath);
}

export async function applyLocalObservationRetention(
  source: AuthorityDb, cutoffValue: unknown, freshPath: string, now: Date = new Date(),
): Promise<LocalObservationRetentionApplication> {
  let fence = retentionSourceFence(source);
  assertRetentionCutoff(cutoffValue);
  // The path is announced before it exists, so a process that dies while copying the snapshot
  // leaves something in the database that explains the directory on disk.
  const directory = resolveRetentionDirectory(source, freshPath);
  let intent: ReturnType<typeof recordRetentionClaimIntent>;
  try {
    intent = recordRetentionClaimIntent(source, directory, now);
  } catch {
    // Another run has already announced this path; it is not this one's to take.
    throw new JarvisError("LOCAL_RETENTION_DESTINATION_INVALID");
  }
  fence = ownWrite(fence, intent.recorded_changes);
  let paths: RetentionPaths;
  const staged = stagedClaimPath(directory, intent.operation_id);
  try {
    paths = claimRetentionOperation(staged);
  } catch (error) {
    // Nothing was created, so whatever the destination holds is somebody else's and untouched.
    fence = ownWrite(fence, clearRetentionClaimIntent(source, intent.operation_id));
    throw error;
  }
  // Owned from here, and recorded while the objects are still under this run's own name: the
  // rename below carries the same inode to the destination, so a crash on either side of it
  // leaves something recovery can prove rather than a destination nobody can account for.
  fence = ownWrite(fence, recordRetentionClaimIdentity(source, intent.operation_id, staged));
  let snapshot: Awaited<ReturnType<typeof captureSelectedSource>>;
  try {
    snapshot = await captureSelectedSource(source, paths.snapshot);
  } catch (error) {
    releaseRetentionOperation(directory);
    fence = ownWrite(fence, clearRetentionClaimIntent(source, intent.operation_id));
    throw error;
  }
  let operation: RetentionOperation | undefined;
  try {
    const selection = selectLocalObservationRetention(snapshot.db, cutoffValue);
    // Recorded before the build so an interrupted run leaves evidence rather than a bare file.
    operation = beginRetentionOperation(source, paths.candidate, paths.snapshot, selection.blocked,
      now, intent.operation_id);
    // The operation row explains the directory from here on, so the intent is spent.
    fence = ownWrite(fence, operation.recorded_changes
      + clearRetentionClaimIntent(source, intent.operation_id));
    // The selection says which groups go; this says that the run's own claim intent is spent. It
    // is not part of the selection and does not enter its digest - the copier and the verifier
    // simply have to agree on it, and they are handed the same list.
    const copied = [...selection.blocked,
      { kind: "intent", id: intent.operation_id, component_id: "local_retention" }];
    const build = await buildFreshAuthority(snapshot, paths.candidate, {
      blocked_projections: copied, sensitive_material: [], destination: "claimed",
    });
    // The candidate must equal what the copier's own plan produces from this snapshot.
    assertCandidateMatchesCopyPlan(snapshot, paths.candidate, copied, build.result_generation);
    const application = { selection, build, source_fence: fence, operation };
    verifyLocalObservationRetentionCandidate(source, application);
    return { ...application,
      source_fence: ownWrite(fence, markRetentionOperationVerified(source, operation, now)) };
  } catch (error) {
    const moved = retentionSourceMoved(source, fence);
    const code = moved ? "LOCAL_RETENTION_SOURCE_CHANGED"
      : error instanceof Error ? error.message : "LOCAL_RETENTION_APPLY_FAILED";
    if (operation === undefined) {
      releaseRetentionOperation(paths.directory);
      clearRetentionClaimIntent(source, intent.operation_id);
    }
    else abandonRetentionOperation(source, operation, code, now);
    if (moved) throw new JarvisError("LOCAL_RETENTION_SOURCE_CHANGED");
    throw error;
  } finally {
    if (snapshot.db.open) snapshot.close();
    // The snapshot has done its work; the candidate stays until it is installed or recovered.
    for (const suffix of ["", "-wal", "-shm", "-journal"]) {
      rmSync(`${paths.snapshot}${suffix}`, { force: true });
    }
  }
}
