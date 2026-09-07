import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { canonicalize } from "./canonical.js";
import { JarvisError } from "./db.js";
import { parseTaskExecutionPlan, taskExecutionPlanDigest, type TaskExecutionPlan } from "./task-execution-plan.js";

import { PinnedDirectory, type CapturedFile } from "./task-workspace-directory.js";
import { inspectTaskPublicationIdentity } from "./task-publication-git.js";

const TOTAL_LIMIT = 16 * 1024 * 1024;
const hash = (bytes: Uint8Array | string) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const fail = (code: string): never => { throw new JarvisError(code); };
export type TaskGitInspector = (root: string) => Promise<{ root: string; commit: string }>;
export interface TaskRepositoryInspection {
  readonly identity?: (root: string) => Promise<string>;
  readonly check?: () => void;
}

export interface TaskRepositoryCheck {
  readonly state: "checked";
  readonly execution_plan_digest: string;
  readonly baseline_commit: string;
  readonly total_bytes: number;
  readonly files: readonly Omit<CapturedFile, "content">[];
  readonly snapshot_digest: string;
}

/** Built-in read-only Git command; ignore inherited repository/config overrides. */
export const inspectTaskGit: TaskGitInspector = async root => {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
  try {
    const { stdout } = await promisify(execFile)("git", ["-c", "core.fsmonitor=false", "-C", root,
      "rev-parse", "--show-toplevel", "HEAD"], { timeout: 10_000, maxBuffer: 16_384, encoding: "utf8",
      env: { ...env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_OPTIONAL_LOCKS: "0" } });
    const lines = stdout.trimEnd().split("\n");
    if (lines.length !== 2 || !lines[0] || !lines[1]) return fail("TASK_REPOSITORY_GIT_INVALID");
    return { root: lines[0], commit: lines[1] };
  } catch { return fail("TASK_REPOSITORY_GIT_UNAVAILABLE"); }
};


async function capture(plan: TaskExecutionPlan, git: TaskGitInspector, inspection: TaskRepositoryInspection = {}) {
  inspection.check?.();
  const root = await PinnedDirectory.open(plan.repository.root);
  try {
    const checkGit = async () => {
      inspection.check?.();
      if (plan.schema_version === 2
        && await (inspection.identity ?? inspectTaskPublicationIdentity)(plan.repository.root) !== plan.publication.repository_identity) {
        return fail("TASK_PUBLICATION_GIT_IDENTITY_CHANGED");
      }
      const observed = await git(root.anchored);
      if (observed.root !== plan.repository.root || observed.commit !== plan.repository.baseline_commit) {
        return fail("TASK_REPOSITORY_BASELINE_CHANGED");
      }
      await root.check();
    };
    await checkGit();
    const files: CapturedFile[] = [];
    let total = 0;
    for (const file of plan.files) {
      inspection.check?.();
      const captured = await root.read(file);
      inspection.check?.();
      total += captured.bytes;
      if (total > TOTAL_LIMIT) return fail("TASK_REPOSITORY_INPUT_OVERSIZE");
      files.push(captured);
    }
    await checkGit();
    const manifest = { state: "checked" as const, execution_plan_digest: taskExecutionPlanDigest(plan),
      baseline_commit: plan.repository.baseline_commit, total_bytes: total,
      files: files.map(file => ({ path: file.path, access: file.access, digest: file.digest,
        bytes: file.bytes, executable: file.executable })) };
    return { files, check: { ...manifest, snapshot_digest: hash(canonicalize(manifest)) } satisfies TaskRepositoryCheck };
  } finally { await root.handle.close(); }
}

export async function inspectTaskExecutionRepository(value: TaskExecutionPlan,
  git: TaskGitInspector = inspectTaskGit, inspection: TaskRepositoryInspection = {}): Promise<TaskRepositoryCheck> {
  try { return (await capture(parseTaskExecutionPlan(value), git, inspection)).check; }
  catch (error) {
    if (error instanceof JarvisError) throw error;
    return fail("TASK_REPOSITORY_UNAVAILABLE");
  }
}

/** Internal execution input boundary; caller must verify current task authority before exposing these bytes to a provider. */
export async function readTaskExecutionInputs(value: TaskExecutionPlan, git: TaskGitInspector = inspectTaskGit) {
  try { return await capture(parseTaskExecutionPlan(value), git); }
  catch (error) {
    if (error instanceof JarvisError) throw error;
    return fail("TASK_REPOSITORY_UNAVAILABLE");
  }
}

/** Prepare candidate inputs only. Neither an OS sandbox nor authority to execute or publish changes. */
export async function prepareTaskExecutionWorkspace(value: TaskExecutionPlan, parent: string,
  git: TaskGitInspector = inspectTaskGit): Promise<{ directory: string; repository: TaskRepositoryCheck }> {
  try { return await prepareWorkspace(value, parent, git); }
  catch (error) {
    if (error instanceof JarvisError) throw error;
    return fail("TASK_WORKSPACE_PREPARE_FAILED");
  }
}

async function prepareWorkspace(value: TaskExecutionPlan, parent: string, git: TaskGitInspector) {
  const plan = parseTaskExecutionPlan(value);
  const parentPath = resolve(parent);
  const sourceRelative = relative(plan.repository.root, parentPath);
  if (parentPath !== parent || sourceRelative === "" || (!sourceRelative.startsWith(`..${sep}`) && sourceRelative !== "..")) {
    return fail("TASK_WORKSPACE_PARENT_INVALID");
  }
  const snapshot = await capture(plan, git);
  const pinned = await PinnedDirectory.open(parentPath, true);
  const directories = new Map<string, PinnedDirectory>();
  try {
    const path = await mkdtemp(join(pinned.anchored, "jarvis-task-"));
    const candidate = await pinned.child(basename(path));
    directories.set(".", candidate);
    for (const file of snapshot.files) {
      let relativeDirectory = ".";
      let directory = candidate;
      if (dirname(file.path) !== ".") for (const component of dirname(file.path).split("/")) {
        relativeDirectory = join(relativeDirectory, component);
        const next = directories.get(relativeDirectory) ?? await directory.child(component, true);
        directories.set(relativeDirectory, next);
        directory = next;
      }
      await directory.write(basename(file.path), file);
    }
    for (const directory of directories.values()) await directory.check();
    await pinned.check();
    return { directory: candidate.path, repository: snapshot.check };
  } catch (error) {
    // Retain failed private candidates: a pathname cleanup could delete a concurrently replaced directory.
    if (error instanceof JarvisError) throw error;
    return fail("TASK_WORKSPACE_PREPARE_FAILED");
  } finally {
    for (const directory of [...directories.values()].reverse()) await directory.handle.close();
    await pinned.handle.close();
  }
}
