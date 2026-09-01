import { resolve } from "node:path";
import { PersonalOsError } from "./personal-os-errors.js";

export const PROTECTED_ROOTS = [
  "/home/jm/.local/state/orca-jarvis",
  "/home/jm/.local/state/second-brain",
  "/home/jm/.local/share/second-brain",
  "/home/jm/.local/share/jarvis",
  "/home/jm/.config/systemd",
  "/home/jm/.config/second-brain",
  "/home/jm/.config/orca-jarvis",
] as const;

function isSameOrInside(path: string, root: string): boolean {
  const resolvedPath = resolve(path);
  const resolvedRoot = resolve(root);
  return resolvedPath === resolvedRoot || resolvedPath.startsWith(`${resolvedRoot}/`);
}

export function assertIsolatedRoot(root: string): string {
  const resolved = resolve(root);
  for (const protectedRoot of PROTECTED_ROOTS) {
    if (isSameOrInside(resolved, protectedRoot) || isSameOrInside(protectedRoot, resolved)) {
      throw new PersonalOsError("E_PROTECTED_ROOT");
    }
  }
  return resolved;
}

export function assertIsolatedFile(path: string): string {
  return assertIsolatedRoot(path);
}
