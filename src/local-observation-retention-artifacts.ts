import { createHash } from "node:crypto";
import { existsSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { JarvisError } from "./jarvis-error.js";

export const SIDECARS = ["-wal", "-shm", "-journal"] as const;

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
