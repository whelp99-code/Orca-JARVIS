import {
  closeSync, existsSync, openSync, readdirSync, readlinkSync, realpathSync, rmSync, statSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type Database from "better-sqlite3";
import { AuthorityDb } from "./db.js";
import { JarvisError } from "./jarvis-error.js";
import {
  selectLocalObservationRetention, type LocalObservationRetentionSelection,
  type RetentionProjection,
} from "./local-observation-retention-selection.js";
import { buildFreshAuthority, type FreshAuthorityBuild } from "./memory-authority-fresh-builder.js";

/**
 * What the candidate was built from. `total_changes` moves when this connection writes and
 * `data_version` moves when any other connection commits. Neither notices a source whose path
 * was replaced underneath the open connection, so the device and inode are those of the file the
 * connection actually has open, checked against the pathname the rebuild adapter will re-open.
 */
export type RetentionSourceFence = {
  readonly data_version: number;
  readonly total_changes: number;
  readonly device: string;
  readonly inode: string;
};
export type LocalObservationRetentionApplication = {
  readonly selection: LocalObservationRetentionSelection;
  readonly build: FreshAuthorityBuild;
  readonly source_fence: RetentionSourceFence;
};

const DESTINATION_SIDECARS = ["-wal", "-shm", "-journal"] as const;

const DELETED_LINK_SUFFIX = " (deleted)";

/**
 * Identity of the file the source connection actually has open, taken from this process's own
 * descriptor table rather than from the pathname.
 *
 * A pathname can be replaced underneath an open connection: the descriptor keeps reading the
 * original file while the name points at another one. Every signal derived from the pathname or
 * from row counts then agrees with itself, which is why neither proves anything here. The rebuild
 * adapter copies by re-opening the pathname, so only the descriptor's device and inode show
 * whether it will read the database the selection read. This reads /proc, where this control
 * plane runs; where it cannot be read, the apply refuses instead of assuming.
 */
function openSourceIdentity(source: AuthorityDb): { readonly device: string; readonly inode: string } {
  const target = resolve(source.filename);
  const identities = new Map<string, { readonly device: string; readonly inode: string }>();
  let entries: readonly string[];
  try { entries = readdirSync("/proc/self/fd"); }
  catch { throw new JarvisError("LOCAL_RETENTION_SOURCE_IDENTITY_UNVERIFIED"); }
  for (const entry of entries) {
    let link: string;
    try { link = readlinkSync(`/proc/self/fd/${entry}`); } catch { continue; }
    const named = link.endsWith(DELETED_LINK_SUFFIX)
      ? link.slice(0, -DELETED_LINK_SUFFIX.length) : link;
    if (named !== target) continue;
    try {
      const opened = statSync(`/proc/self/fd/${entry}`, { bigint: true });
      identities.set(`${opened.dev}:${opened.ino}`,
        { device: opened.dev.toString(), inode: opened.ino.toString() });
    } catch { continue; }
  }
  // No descriptor, or descriptors on different files under one name, leaves the binding unproven.
  const [identity, ...rest] = [...identities.values()];
  if (identity === undefined || rest.length !== 0) {
    throw new JarvisError("LOCAL_RETENTION_SOURCE_IDENTITY_UNVERIFIED");
  }
  return identity;
}

function retentionSourceFence(source: AuthorityDb): RetentionSourceFence {
  const open = openSourceIdentity(source);
  const named = statSync(source.filename, { bigint: true });
  if (named.dev.toString() !== open.device || named.ino.toString() !== open.inode) {
    throw new JarvisError("LOCAL_RETENTION_SOURCE_IDENTITY_MISMATCH");
  }
  return {
    data_version: Number(source.db.pragma("data_version", { simple: true })),
    total_changes: Number(source.db.prepare("SELECT total_changes()").pluck().get()),
    device: open.device,
    inode: open.inode,
  };
}

/** True when the source moved past the fence, including a path replaced by another file. */
function retentionFenceMoved(source: AuthorityDb, fence: RetentionSourceFence): boolean {
  let current: RetentionSourceFence;
  try {
    current = retentionSourceFence(source);
  } catch {
    return true;
  }
  return current.data_version !== fence.data_version || current.total_changes !== fence.total_changes
    || current.device !== fence.device || current.inode !== fence.inode;
}

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
  if (retentionFenceMoved(source, application.source_fence)) {
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

/**
 * Tables whose row counts the copy must reproduce: the first two lose precisely what the
 * selection blocked, the rest are untouched by any retention selection. This is a bounded
 * cross-check, not a proof of content - equal counts can hide different rows entirely, which is
 * why the source identity above, not this, is what binds the copy to the selection.
 */
const CANDIDATE_UNAFFECTED = ["gjc_intents", "notification_intents",
  "personal_context_audit_events", "local_timeline_subjects"] as const;

function tableCount(database: Database.Database, table: string): number {
  return Number(database.prepare(`SELECT COUNT(*) FROM ${table}`).pluck().get());
}

/**
 * Proves the candidate was copied from the database the selection actually read.
 *
 * The fence pins this connection's counters and the pathname's device and inode, but a pathname
 * replaced before the apply started would be consistent with itself while the open connection
 * still reads the original file: selection would describe one database and the adapter, which
 * attaches by pathname through its own connection, would copy another. Comparing the copied row
 * counts against the connection the selection used closes that gap without trusting either
 * pathname.
 */
function assertCandidateMatchesSelection(
  source: AuthorityDb, destination: string, selection: LocalObservationRetentionSelection,
): void {
  const removed = (kind: RetentionProjection["kind"]): number =>
    selection.blocked.filter(item => item.kind === kind).length;
  const expected = new Map<string, number>([
    ["personal_observations", tableCount(source.db, "personal_observations") - removed("observation")],
    ["personal_recommendations",
      tableCount(source.db, "personal_recommendations") - removed("recommendation")],
    ...CANDIDATE_UNAFFECTED.map(table => [table, tableCount(source.db, table)] as const),
  ]);
  const candidate = new AuthorityDb(destination, undefined, { readonly: true, fileMustExist: true });
  let mismatch: string | undefined;
  try {
    for (const [table, count] of expected) {
      if (tableCount(candidate.db, table) !== count) { mismatch = table; break; }
    }
  } finally {
    candidate.close();
    for (const suffix of DESTINATION_SIDECARS) rmSync(`${destination}${suffix}`, { force: true });
  }
  if (mismatch !== undefined) throw new JarvisError("LOCAL_RETENTION_CANDIDATE_MISMATCH");
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
export async function applyLocalObservationRetention(
  source: AuthorityDb, cutoffValue: unknown, freshPath: string,
): Promise<LocalObservationRetentionApplication> {
  const fence = retentionSourceFence(source);
  const selection = selectLocalObservationRetention(source.db, cutoffValue);
  const destination = claimRetentionDestination(source, freshPath);
  try {
    const build = await buildFreshAuthority(source, destination, {
      blocked_projections: selection.blocked, sensitive_material: [], destination: "claimed",
    });
    const application = { selection, build, source_fence: fence };
    // What was copied is checked before why it might differ: a pathname swapped before this call
    // is self-consistent for the fence, and only the copy itself shows the divergence.
    assertCandidateMatchesSelection(source, destination, selection);
    verifyLocalObservationRetentionCandidate(source, application);
    return application;
  } catch (error) {
    releaseRetentionDestination(destination);
    // A build that failed while the source was moving failed because of that movement; report the
    // cause the caller can act on rather than the downstream symptom it produced.
    if (retentionFenceMoved(source, fence)) throw new JarvisError("LOCAL_RETENTION_SOURCE_CHANGED");
    throw error;
  }
}
