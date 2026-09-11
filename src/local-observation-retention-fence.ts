import { readdirSync, readlinkSync, statSync } from "node:fs";
import { resolve } from "node:path";
import type { AuthorityDb } from "./db.js";
import { JarvisError } from "./jarvis-error.js";

const DELETED_LINK_SUFFIX = " (deleted)";

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
/** Re-bases a fence over rows this connection wrote itself, leaving every other writer visible. */
export const ownWrite = (fence: RetentionSourceFence, rows: number): RetentionSourceFence =>
  ({ ...fence, total_changes: fence.total_changes + rows });

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

export function retentionSourceFence(source: AuthorityDb): RetentionSourceFence {
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
export function retentionSourceMoved(source: AuthorityDb, fence: RetentionSourceFence): boolean {
  let current: RetentionSourceFence;
  try {
    current = retentionSourceFence(source);
  } catch {
    return true;
  }
  return current.data_version !== fence.data_version || current.total_changes !== fence.total_changes
    || current.device !== fence.device || current.inode !== fence.inode;
}

