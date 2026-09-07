import { createHash } from "node:crypto";
import { chmod, link, mkdir, mkdtemp, readFile, realpath, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { inspectTaskExecutionRepository, prepareTaskExecutionWorkspace, type TaskGitInspector } from "../../src/task-execution-workspace.js";
import type { TaskExecutionPlanV1 } from "../../src/task-execution-plan.js";
import { executionPlan } from "../fixtures/task-execution-fixture.js";

vi.mock("node:fs/promises", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, mkdir: vi.fn(actual.mkdir) };
});
const actualFs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");

let root: string;
let repository: string;
let parent: string;
let plan: TaskExecutionPlanV1;
let git: TaskGitInspector;
const digest = (value: string | Buffer) => `sha256:${createHash("sha256").update(value).digest("hex")}`;

describe.skipIf(process.platform !== "linux")("pinned execution inputs and private candidate workspaces", () => {
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "jarvis-task-workspace-"));
    repository = join(root, "repository"); parent = join(root, "workspaces");
    await mkdir(join(repository, "src"), { recursive: true });
    await mkdir(join(repository, "tests")); await mkdir(parent, { mode: 0o700 });
    await writeFile(join(repository, "src/fix.ts"), "original");
    await writeFile(join(repository, "tests/check.mjs"), "check");
    await writeFile(join(repository, "unselected-secret"), "must not be copied");
    plan = { ...executionPlan(), repository: { root: repository, baseline_commit: "a".repeat(40) },
      files: [{ path: "src/fix.ts", access: "write", before_digest: digest("original") },
        { path: "tests/check.mjs", access: "read", before_digest: digest("check") },
        { path: "new/result.ts", access: "write", before_digest: null }] };
    git = async pinned => ({ root: await realpath(pinned), commit: "a".repeat(40) });
  });
  afterEach(async () => {
    vi.mocked(mkdir).mockReset().mockImplementation(actualFs.mkdir);
    await rm(root, { recursive: true, force: true });
  });

  it("checks exact declared bytes and copies only those inputs into a private candidate", async () => {
    const checked = await inspectTaskExecutionRepository(plan, git);
    expect(checked).toMatchObject({ state: "checked", total_bytes: 13, files: [
      { path: "src/fix.ts", digest: digest("original"), bytes: 8 },
      { path: "tests/check.mjs", digest: digest("check"), bytes: 5 },
      { path: "new/result.ts", digest: null, bytes: 0 },
    ] });
    expect(JSON.stringify(checked)).not.toContain("content");
    const prepared = await prepareTaskExecutionWorkspace(plan, parent, git);
    expect(prepared.repository).toEqual(checked);
    expect((await stat(prepared.directory)).mode & 0o077).toBe(0);
    expect(await readFile(join(prepared.directory, "src/fix.ts"), "utf8")).toBe("original");
    expect((await stat(join(prepared.directory, "tests/check.mjs"))).mode & 0o777).toBe(0o400);
    await expect(stat(join(prepared.directory, "unselected-secret"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(join(prepared.directory, "new/result.ts"))).rejects.toMatchObject({ code: "ENOENT" });
    await writeFile(join(prepared.directory, "src/fix.ts"), "candidate");
    expect(await readFile(join(repository, "src/fix.ts"), "utf8")).toBe("original");
  });

  it.each(["changed", "missing", "symlink", "parent_symlink", "hardlink", "directory", "oversize", "new_exists"])(
    "rejects %s selected input before creating a candidate", async change => {
      const file = join(repository, "src/fix.ts");
      if (change === "changed") await writeFile(file, "modified");
      if (change === "missing") await rm(file);
      if (change === "symlink") { await rm(file); await symlink(join(repository, "tests/check.mjs"), file); }
      if (change === "parent_symlink") {
        await rename(join(repository, "src"), join(root, "outside")); await symlink(join(root, "outside"), join(repository, "src"));
      }
      if (change === "hardlink") await link(file, join(root, "alias"));
      if (change === "directory") { await rm(file); await mkdir(file); }
      if (change === "oversize") await writeFile(file, Buffer.alloc(4 * 1024 * 1024 + 1));
      if (change === "new_exists") {
        await mkdir(join(repository, "new")); await writeFile(join(repository, "new/result.ts"), "already exists");
      }
      await expect(prepareTaskExecutionWorkspace(plan, parent, git)).rejects.toMatchObject({ code: expect.stringMatching(/^TASK_REPOSITORY_/) });
    },
  );

  it.each(["commit", "root", "moved_during_capture"])("rejects a changed repository %s", async change => {
    let calls = 0;
    const changed: TaskGitInspector = async pinned => {
      calls++;
      if (change === "moved_during_capture" && calls === 2) {
        await rename(repository, join(root, "old")); await mkdir(repository);
      }
      return { root: change === "root" ? root : await realpath(pinned),
        commit: change === "commit" && calls === 2 ? "b".repeat(40) : "a".repeat(40) };
    };
    await expect(inspectTaskExecutionRepository(plan, changed)).rejects.toMatchObject({ code: expect.stringMatching(/^TASK_REPOSITORY_/) });
  });

  it("rejects an aliased source root and public or in-repository candidate parents", async () => {
    const alias = join(root, "alias"); await symlink(repository, alias);
    await expect(inspectTaskExecutionRepository({ ...plan, repository: { ...plan.repository, root: alias } }, git))
      .rejects.toMatchObject({ code: "TASK_REPOSITORY_PATH_INVALID" });
    await expect(prepareTaskExecutionWorkspace(plan, repository, git)).rejects.toMatchObject({ code: "TASK_WORKSPACE_PARENT_INVALID" });
    await chmod(parent, 0o755);
    await expect(prepareTaskExecutionWorkspace(plan, parent, git)).rejects.toMatchObject({ code: "TASK_WORKSPACE_PARENT_INVALID" });
  });

  it("bounds aggregate input bytes across otherwise valid files", async () => {
    const content = Buffer.alloc(4 * 1024 * 1024);
    const files: TaskExecutionPlanV1["files"][number][] = [];
    for (let index = 0; index < 5; index++) {
      const path = `large-${index}`; await writeFile(join(repository, path), content);
      files.push({ path, access: "write", before_digest: digest(content) });
    }
    await expect(inspectTaskExecutionRepository({ ...plan, files }, git))
      .rejects.toMatchObject({ code: "TASK_REPOSITORY_INPUT_OVERSIZE" });
  });

  it("rejects a replaced candidate parent without writing through its symlink", async () => {
    const outside = join(root, "outside"); await mkdir(outside);
    let replaced = false;
    vi.mocked(mkdir).mockImplementation((async (path: string, options: unknown) => {
      const result = await actualFs.mkdir(path, options as Parameters<typeof mkdir>[1]);
      if (!replaced && String(path).startsWith("/proc/") && String(path).endsWith("/src")) {
        replaced = true; await rm(path, { recursive: true }); await symlink(outside, path);
      }
      return result;
    }) as typeof mkdir);
    await expect(prepareTaskExecutionWorkspace(plan, parent, git)).rejects.toMatchObject({ code: "TASK_WORKSPACE_PREPARE_FAILED" });
    expect(replaced).toBe(true);
    await expect(stat(join(outside, "fix.ts"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not recursively remove a replacement directory when preparation fails", async () => {
    let replacement: string | undefined;
    vi.mocked(mkdir).mockImplementation((async (path: string, options: unknown) => {
      const result = await actualFs.mkdir(path, options as Parameters<typeof mkdir>[1]);
      if (!replacement && String(path).startsWith("/proc/") && String(path).endsWith("/src")) {
        replacement = await realpath(join(path, ".."));
        await rename(replacement, join(root, "retained-candidate"));
        await actualFs.mkdir(replacement); await writeFile(join(replacement, "sentinel"), "preserve");
        throw new Error("injected preparation failure");
      }
      return result;
    }) as typeof mkdir);
    await expect(prepareTaskExecutionWorkspace(plan, parent, git)).rejects.toMatchObject({ code: "TASK_WORKSPACE_PREPARE_FAILED" });
    expect(replacement).toBeDefined();
    expect(await readFile(join(replacement!, "sentinel"), "utf8")).toBe("preserve");
  });
});
