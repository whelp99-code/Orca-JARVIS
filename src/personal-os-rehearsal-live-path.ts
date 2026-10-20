import { lstatSync } from "node:fs";
import { type DeploymentEnvironment } from "./personal-os-deployment-roots.js";
import { protectedRoots } from "./personal-os-protected-paths.js";

const NAMED_ROOTS = [
  "/home/jm/.local/state/orca-jarvis",
  "/var/lib/jarvis-svc",
  "/opt/jarvis-runtime",
  "/home/jm/.local/state/orca-jarvis-phone-gateway",
  "/home/jm/.local/state/second-brain",
  "/home/jm/.config/systemd/user/jm-jarvis.service",
] as const;

export type LivePathSnapshot = {
  readonly path: string;
  readonly present: boolean;
  readonly mtime_ns: string | null;
  readonly ino: number | null;
};

function identity(path: string): LivePathSnapshot {
  try {
    const stat = lstatSync(path);
    return { path, present: true, mtime_ns: String(stat.mtimeMs), ino: stat.ino };
  } catch {
    return { path, present: false, mtime_ns: null, ino: null };
  }
}

export type LivePathRoots = {
  readonly environment?: DeploymentEnvironment;
  readonly namedRoots?: readonly string[];
};

export function snapshotLivePaths(roots: LivePathRoots = {}): readonly LivePathSnapshot[] {
  const paths = [...new Set([...(roots.namedRoots ?? NAMED_ROOTS), ...protectedRoots(roots.environment)])];
  return paths.map(identity);
}

export function livePathsUnchanged(
  before: readonly LivePathSnapshot[],
  after: readonly LivePathSnapshot[],
): boolean {
  if (before.length !== after.length) return false;
  return before.every((left, index) => {
    const right = after[index];
    return right !== undefined
      && left.path === right.path
      && left.present === right.present
      && left.mtime_ns === right.mtime_ns
      && left.ino === right.ino;
  });
}
