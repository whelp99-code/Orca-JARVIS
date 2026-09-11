import {
  closeSync, existsSync, openSync, realpathSync, rmSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
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
  abandonRetentionOperation, beginRetentionOperation, markRetentionOperationVerified,
  releaseRetentionCandidate, type RetentionOperation,
} from "./local-observation-retention-operation.js";
import { buildFreshAuthority, type FreshAuthorityBuild } from "./memory-authority-fresh-builder.js";

export type { RetentionSourceFence } from "./local-observation-retention-fence.js";
export { retentionSourceMoved } from "./local-observation-retention-fence.js";

export type LocalObservationRetentionApplication = {
  readonly selection: LocalObservationRetentionSelection;
  readonly build: FreshAuthorityBuild;
  readonly source_fence: RetentionSourceFence;
  readonly operation: RetentionOperation;
};

const DESTINATION_SIDECARS = ["-wal", "-shm", "-journal"] as const;

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
 * Takes exclusive ownership of the destination name before anything writes through it.
 *
 * String inequality is not file inequality: `/dir/./authority.sqlite`, a relative spelling and a
 * symlink all name the source, and the rebuild adapter removes its destination. The claim resolves
 * the real path, refuses the source's own file, refuses a name whose SQLite sidecars already exist,
 * and then creates the file with O_EXCL so a second caller racing for the same name loses instead
 * of sharing it. Nothing that existed before this call is ever removed.
 */
function claimRetentionDestination(source: AuthorityDb, freshPath: string): string {
  if (typeof freshPath !== "string" || freshPath.trim().length === 0) {
    throw new JarvisError("LOCAL_RETENTION_DESTINATION_INVALID");
  }
  const absolute = resolve(freshPath);
  let destination: string;
  let sourcePath: string;
  try {
    destination = join(realpathSync(dirname(absolute)), basename(absolute));
    sourcePath = realpathSync(source.filename);
  } catch {
    throw new JarvisError("LOCAL_RETENTION_DESTINATION_INVALID");
  }
  if (destination === sourcePath
    || DESTINATION_SIDECARS.some(suffix => existsSync(`${destination}${suffix}`))) {
    throw new JarvisError("LOCAL_RETENTION_DESTINATION_INVALID");
  }
  try {
    closeSync(openSync(destination, "wx", 0o600));
  } catch {
    throw new JarvisError("LOCAL_RETENTION_DESTINATION_INVALID");
  }
  return destination;
}

/** Removes only the file this call created, plus the sidecars the build put beside it. */
function releaseRetentionDestination(destination: string): void {
  for (const suffix of DESTINATION_SIDECARS) rmSync(`${destination}${suffix}`, { force: true });
  rmSync(destination, { force: true });
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
    releaseRetentionDestination(snapshotPath);
    throw new JarvisError("LOCAL_RETENTION_SOURCE_SNAPSHOT_FAILED");
  }
  return new AuthorityDb(snapshotPath);
}

export async function applyLocalObservationRetention(
  source: AuthorityDb, cutoffValue: unknown, freshPath: string, now: Date = new Date(),
): Promise<LocalObservationRetentionApplication> {
  let fence = retentionSourceFence(source);
  assertRetentionCutoff(cutoffValue);
  const destination = claimRetentionDestination(source, freshPath);
  const snapshotPath = `${destination}.selected-source`;
  // Claimed exclusively like the candidate: a file already sitting there belongs to somebody else
  // and must not be written over or, on failure, deleted. Until the operation row exists there is
  // nothing to explain a leftover candidate either, so a failure here takes it back.
  let claimed = false;
  let snapshot: Awaited<ReturnType<typeof captureSelectedSource>>;
  try {
    claimRetentionDestination(source, snapshotPath);
    claimed = true;
    snapshot = await captureSelectedSource(source, snapshotPath);
  } catch (error) {
    if (claimed) releaseRetentionDestination(snapshotPath);
    releaseRetentionDestination(destination);
    throw error;
  }
  let operation: RetentionOperation | undefined;
  try {
    const selection = selectLocalObservationRetention(snapshot.db, cutoffValue);
    // Recorded before the build so an interrupted run leaves evidence rather than a bare file.
    operation = beginRetentionOperation(source, destination, snapshotPath, selection.blocked, now);
    fence = ownWrite(fence, operation.recorded_changes);
    const build = await buildFreshAuthority(snapshot, destination, {
      blocked_projections: selection.blocked, sensitive_material: [], destination: "claimed",
    });
    // The candidate must equal what the copier's own plan produces from this snapshot.
    assertCandidateMatchesCopyPlan(snapshot, destination, selection.blocked, build.result_generation);
    const application = { selection, build, source_fence: fence, operation };
    verifyLocalObservationRetentionCandidate(source, application);
    return { ...application,
      source_fence: ownWrite(fence, markRetentionOperationVerified(source, operation, now)) };
  } catch (error) {
    const moved = retentionSourceMoved(source, fence);
    const code = moved ? "LOCAL_RETENTION_SOURCE_CHANGED"
      : error instanceof Error ? error.message : "LOCAL_RETENTION_APPLY_FAILED";
    if (operation === undefined) releaseRetentionCandidate(destination);
    else abandonRetentionOperation(source, operation, code, now);
    if (moved) throw new JarvisError("LOCAL_RETENTION_SOURCE_CHANGED");
    throw error;
  } finally {
    if (snapshot.db.open) snapshot.close();
    releaseRetentionDestination(snapshotPath);
  }
}
