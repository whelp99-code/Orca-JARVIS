import { realpathSync } from "node:fs";
import { JarvisError } from "./db.js";
import type { OrcaRunner } from "./orca.js";

/** Virtual absolute path prefix for non-local Orca environments. */
export const ORCA_ENV_PATH_PREFIX = "/orca-env/";
export const LOCAL_ORCA_ENVIRONMENT = "local";

export function parseOrcaEnvironments(raw?: string | null): string[] {
  const source = (raw ?? process.env.ORCA_JARVIS_ENVIRONMENTS ?? `${LOCAL_ORCA_ENVIRONMENT},jm-server`).trim();
  const parts = source.split(",").map(part => part.trim()).filter(Boolean);
  const seen = new Set<string>();
  const environments: string[] = [];
  for (const part of parts) {
    if (seen.has(part)) continue;
    seen.add(part);
    environments.push(part);
  }
  return environments.length > 0 ? environments : [LOCAL_ORCA_ENVIRONMENT];
}

/**
 * Local paths stay as realpath. Remote paths are stored as
 * `/orca-env/<environment><absolute-remote-path>` so they satisfy the
 * absolute-path CHECK and never require a local filesystem mount.
 */
export function encodeEnvWorktree(environment: string, absolutePath: string): string {
  if (!absolutePath.startsWith("/")) throw new JarvisError("ORCA_WORKTREE_INVALID");
  const normalized = absolutePath.replace(/\/+$/u, "") || "/";
  if (!environment || environment === LOCAL_ORCA_ENVIRONMENT) {
    try {
      return realpathSync(normalized);
    } catch {
      throw new JarvisError("ORCA_WORKTREE_INVALID");
    }
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(environment)) throw new JarvisError("ORCA_WORKTREE_INVALID");
  return `${ORCA_ENV_PATH_PREFIX}${environment}${normalized}`;
}

export function decodeEnvWorktree(canonical: string): { environment: string; orcaWorktree: string; listSelector: string } {
  if (!canonical.startsWith("/")) throw new JarvisError("ORCA_WORKTREE_INVALID");
  if (canonical.startsWith(ORCA_ENV_PATH_PREFIX)) {
    const rest = canonical.slice(ORCA_ENV_PATH_PREFIX.length);
    const slash = rest.indexOf("/");
    if (slash <= 0) throw new JarvisError("ORCA_WORKTREE_INVALID");
    const environment = rest.slice(0, slash);
    const orcaWorktree = rest.slice(slash);
    if (!environment || !orcaWorktree.startsWith("/")) throw new JarvisError("ORCA_WORKTREE_INVALID");
    return { environment, orcaWorktree, listSelector: `path:${orcaWorktree}` };
  }
  return { environment: LOCAL_ORCA_ENVIRONMENT, orcaWorktree: canonical, listSelector: canonical };
}

/** Inject `--environment <name>` after the primary Orca command tokens. */
export function withOrcaEnvironment(args: readonly string[], environment: string): string[] {
  if (!environment || environment === LOCAL_ORCA_ENVIRONMENT) return [...args];
  const next = [...args];
  let insertAt = 0;
  if (next[0] === "terminal" && next[1]) insertAt = 2;
  else if (next[0] === "worktree" || next[0] === "status" || next[0] === "orchestration") insertAt = next[1] && !next[1].startsWith("-") ? 2 : 1;
  else if (next[0] && !next[0].startsWith("-")) insertAt = 1;
  next.splice(insertAt, 0, "--environment", environment);
  return next;
}

export function createOrcaRunner(environment: string, base: OrcaRunner): OrcaRunner {
  if (!environment || environment === LOCAL_ORCA_ENVIRONMENT) return base;
  return async args => base(withOrcaEnvironment(args, environment));
}
