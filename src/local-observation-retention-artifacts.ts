import { createHash } from "node:crypto";
import { existsSync, readFileSync, rmSync, statSync } from "node:fs";
import { dirname } from "node:path";
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
 * Removes the directory the operation writes inside, which is everything it owns.
 *
 * The candidate and the snapshot live in a directory this operation created, so releasing is one
 * removal of a name nobody else writes to. There is no file beside them to guess at and no second
 * step for a crash to land between.
 */
export function releaseRetentionOperationDirectory(candidatePath: string): void {
  rmSync(dirname(candidatePath), { recursive: true, force: true });
}
