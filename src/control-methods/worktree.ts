import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { canonicalize } from "../canonical.js";
import { JarvisError } from "../db.js";

export type WorktreeCreateArgs = {
  readonly repository: string;
  readonly parentPath: string;
  readonly branch: string;
  readonly name: string;
};

export type WorktreeCreateResult = {
  readonly path: string;
  readonly branch: string;
  readonly created: boolean;
  readonly stdout: string;
  readonly stderr: string;
  readonly exit: number;
};

export function worktreeEffectKey(args: WorktreeCreateArgs): string {
  return `sha256:${createHash("sha256").update(canonicalize({
    action: "worktree.create",
    repository: resolve(args.repository),
    parent_path: resolve(args.parentPath),
    branch: args.branch,
    name: args.name,
  })).digest("hex")}`;
}

export function worktreeDestination(args: WorktreeCreateArgs): string {
  return join(resolve(args.parentPath), args.name);
}

export function inspectWorktree(args: WorktreeCreateArgs): { exists: boolean; path: string } {
  const path = worktreeDestination(args);
  return { exists: existsSync(join(path, ".git")) || existsSync(path), path };
}

export function resolveOrcaBin(explicit?: string): string {
  if (explicit) return explicit;
  for (const candidate of ["/Users/jmpark/.local/bin/orca", "/usr/local/bin/orca"]) {
    if (existsSync(candidate)) return candidate;
  }
  return "orca";
}

function parseLeadingJson(text: string): Record<string, unknown> | undefined {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return undefined;
  try { return JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>; } catch { return undefined; }
}

function orcaJson(orcaBin: string, argv: readonly string[]): { status: number | null; stdout: string; stderr: string; parsed: Record<string, unknown> | undefined } {
  const result = spawnSync(orcaBin, [...argv], {
    encoding: "utf8",
    timeout: 90_000,
    env: { ...process.env, PATH: `/Users/jmpark/.local/bin:/usr/local/bin:${process.env.PATH ?? ""}` },
  });
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    parsed: parseLeadingJson(result.stdout) ?? parseLeadingJson(result.stderr),
  };
}

function errorCode(parsed: Record<string, unknown> | undefined): string | undefined {
  const error = parsed?.error;
  if (typeof error === "object" && error && "code" in error) return String((error as { code?: string }).code);
  return undefined;
}

function createdPath(parsed: Record<string, unknown> | undefined): { path?: string; branch?: string } | undefined {
  const payload = parsed?.result as { path?: string; branch?: string; worktree?: { path?: string; branch?: string } } | undefined;
  return payload?.worktree ?? payload;
}

export function createOrcaManagedWorktree(args: WorktreeCreateArgs, orcaBin = resolveOrcaBin()): WorktreeCreateResult {
  const destination = worktreeDestination(args);
  const selectors = args.repository.includes("/")
    ? [`path:${resolve(args.repository)}`]
    : [`name:${args.repository}`, "path:/Users/jmpark/Orca-JARVIS", "path:/Volumes/DevSpace/Orca-JARVIS"];
  let last = "";
  for (const selector of selectors) {
    const invoke = (): ReturnType<typeof orcaJson> => orcaJson(orcaBin, [
      "worktree", "create",
      "--name", args.name,
      "--repo", selector,
      "--setup", "skip",
      "--no-parent",
      "--json",
    ]);
    let result = invoke();
    const code = errorCode(result.parsed);
    if (code === "already_exists" || code === "worktree_exists" || code === "branch_exists") {
      orcaJson(orcaBin, ["worktree", "rm", "--worktree", `name:${args.name}`, "--force", "--json"]);
      result = invoke();
    }
    if (result.parsed?.ok === true) {
      const created = createdPath(result.parsed);
      const path = created?.path ?? destination;
      if (path) {
        return {
          path,
          branch: created?.branch ?? args.branch,
          created: true,
          stdout: result.stdout,
          stderr: result.stderr,
          exit: result.status ?? 0,
        };
      }
    }
    last = result.stderr || result.stdout || code || last;
  }
  const gitRepo = existsSync("/Volumes/DevSpace/Orca-JARVIS/.git") ? "/Volumes/DevSpace/Orca-JARVIS" : args.repository;
  try {
    return createLocalWorktree({ ...args, repository: gitRepo });
  } catch (error) {
    const extra = error instanceof Error ? error.message : "git_failed";
    throw new JarvisError("WORKTREE_CREATE_FAILED", last || extra);
  }
}

export function removeOrcaManagedWorktree(selector: string, orcaBin = resolveOrcaBin()): void {
  const result = orcaJson(orcaBin, ["worktree", "rm", "--worktree", selector, "--force", "--json"]);
  if (result.parsed?.ok !== true && result.status !== 0) {
    throw new JarvisError("WORKTREE_REMOVE_FAILED", result.stderr || result.stdout || "WORKTREE_REMOVE_FAILED");
  }
}

export function createLocalWorktree(args: WorktreeCreateArgs): WorktreeCreateResult {
  const destination = worktreeDestination(args);
  const existing = inspectWorktree(args);
  if (existing.exists) {
    return { path: destination, branch: args.branch, created: false, stdout: "", stderr: "already_exists", exit: 0 };
  }
  const result = spawnSync("git", ["-C", resolve(args.repository), "worktree", "add", destination, "-b", args.branch], {
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new JarvisError("WORKTREE_CREATE_FAILED", result.stderr || result.stdout || "WORKTREE_CREATE_FAILED");
  }
  return {
    path: destination,
    branch: args.branch,
    created: true,
    stdout: result.stdout,
    stderr: result.stderr,
    exit: result.status ?? 0,
  };
}
