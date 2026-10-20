import { dirname, resolve } from "node:path";
import {
  type DeploymentEnvironment,
  resolveDeploymentRoots,
} from "./personal-os-deployment-roots.js";
import { PersonalOsError } from "./personal-os-errors.js";

export const NAMED_ROOTS = [
  "/home/jm/.local/state/orca-jarvis",
  "/var/lib/jarvis-svc",
  "/opt/jarvis-runtime",
  "/home/jm/.local/state/orca-jarvis-phone-gateway",
  "/home/jm/.local/state/second-brain",
  "/home/jm/.config/systemd/user/jm-jarvis.service",
] as const;

/**
 * The roots a test, rehearsal or release may never write into. They follow the configured
 * deployment (JARVIS_STATE_ROOT and friends), because the point of the list is to name wherever
 * production actually lives — not wherever it used to live.
 */
export function protectedRoots(environment?: DeploymentEnvironment): readonly string[] {
  const roots = resolveDeploymentRoots(environment);
  return [
    roots.stateRoot,
    roots.providerStateRoot,
    roots.providerShareRoot,
    roots.authorityShareRoot,
    `${roots.configRoot}/systemd`,
    dirname(roots.providerConfig),
    `${roots.configRoot}/orca-jarvis`,
  ];
}

function isSameOrInside(path: string, root: string): boolean {
  const resolvedPath = resolve(path);
  const resolvedRoot = resolve(root);
  return resolvedPath === resolvedRoot || resolvedPath.startsWith(`${resolvedRoot}/`);
}

export function assertIsolatedRoot(
  root: string,
  environment?: DeploymentEnvironment,
  additionalRoots: readonly string[] = [],
): string {
  const resolved = resolve(root);
  // Observation fixtures may add exclusions, never replace live deployment protection.
  const roots = new Set([
    ...protectedRoots(), ...protectedRoots({}), ...NAMED_ROOTS,
    ...protectedRoots(environment), ...additionalRoots,
  ]);
  for (const protectedRoot of roots) {
    if (isSameOrInside(resolved, protectedRoot) || isSameOrInside(protectedRoot, resolved)) {
      throw new PersonalOsError("E_PROTECTED_ROOT");
    }
  }
  return resolved;
}

export function assertIsolatedFile(path: string, environment?: DeploymentEnvironment): string {
  return assertIsolatedRoot(path, environment);
}
