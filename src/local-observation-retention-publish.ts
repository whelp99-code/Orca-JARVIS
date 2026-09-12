import { existsSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";

const SIDECARS = ["-wal", "-shm", "-journal"] as const;

/** What a publish that has not finished moving the old log leaves behind, and enough to prove it. */
type PublishPhase = {
  readonly operation_id: string;
  readonly retired_database: string;
  readonly published: { readonly device: string; readonly inode: string };
  readonly retired_identity: { readonly device: string; readonly inode: string };
};

export function publishPhasePath(database: string): string {
  return `${database}.publishing`;
}

/** Written before the publish: from here the live name may be the new database with the old log. */
export function beginPublishPhase(database: string, phase: PublishPhase): void {
  writeFileSync(publishPhasePath(database), `${JSON.stringify(phase)}\n`, { flag: "wx" });
}

export function endPublishPhase(database: string): void {
  rmSync(publishPhasePath(database), { force: true });
}

function identify(path: string): { device: string; inode: string } | undefined {
  try {
    const stat = statSync(path, { bigint: true });
    return { device: stat.dev.toString(), inode: stat.ino.toString() };
  } catch { return undefined; }
}

/**
 * Finishes, or abandons, a publish that stopped between the rename and the log moving beside the
 * database it belongs to. Nothing here trusts a name: the live path is identified and compared
 * against what the phase recorded, so the log is only moved off a database that is provably the
 * published one, and a phase that describes some other state is left alone rather than acted on.
 *
 * A live path carrying a log from the inode it replaced is not openable as either database, so
 * this runs before an authority connection is made rather than after something has read it.
 */
export function settlePublishPhase(database: string): "none" | "completed" | "unproven" | "reverted" {
  const path = publishPhasePath(database);
  if (!existsSync(path)) return "none";
  let phase: PublishPhase;
  try { phase = JSON.parse(readFileSync(path, "utf8")) as PublishPhase; }
  catch { return "unproven"; }
  const live = identify(database);
  if (live === undefined) return "unproven";
  if (live.device === phase.published.device && live.inode === phase.published.inode) {
    // The publish happened. Any log under the live name belongs to the inode that was retired.
    for (const suffix of SIDECARS) {
      const sidecar = `${database}${suffix}`;
      if (existsSync(sidecar)) renameSync(sidecar, `${phase.retired_database}${suffix}`);
    }
    rmSync(path, { force: true });
    return "completed";
  }
  if (live.device === phase.retired_identity.device && live.inode === phase.retired_identity.inode) {
    // The publish never happened: the live name is still the original database, and its log is its
    // own. The phase is over because there is nothing of it left to finish.
    rmSync(path, { force: true });
    return "reverted";
  }
  // Neither: something else holds the live name, and nothing here can say what its log belongs to.
  return "unproven";
}
