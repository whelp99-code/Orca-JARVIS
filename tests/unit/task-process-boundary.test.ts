import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { JarvisError } from "../../src/db.js";
import { ClaudeTaskCandidateProvider } from "../../src/claude-task-provider.js";
import { spawnTaskSandbox } from "../../src/task-sandbox.js";
import { taskProcessTimeout } from "../../src/task-process-boundary.js";

const io = vi.hoisted(() => ({ prepare: vi.fn(), spawn: vi.fn(), close: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: io.spawn }));
vi.mock("node:fs/promises", async importOriginal => ({
  ...await importOriginal<typeof import("node:fs/promises")>(),
  realpath: async (path: string) => path,
  access: async () => undefined,
  stat: async () => { await io.prepare(); return { isFile: () => true, mode: 0o700 }; },
  open: async () => { await io.prepare(); return { fd: 3, close: io.close }; },
}));
beforeEach(() => { vi.clearAllMocks(); io.prepare.mockResolvedValue(undefined); });
afterEach(() => vi.restoreAllMocks());

describe("task subprocess preparation boundary", () => {
  it.each(["provider", "verifier"])("checks current authority after asynchronous %s preparation, before spawning", async kind => {
    let authorized = true;
    let enter!: () => void, release!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve; });
    const resume = new Promise<void>(resolve => { release = resolve; });
    io.prepare.mockImplementation(async () => { enter(); await resume; });
    const before_spawn = vi.fn(() => {
      if (!authorized) throw new JarvisError("CONTROL_APPROVAL_REVOKED");
      return 1000;
    });
    const pending = kind === "provider"
      ? new ClaudeTaskCandidateProvider("/trusted/claude").generate({ provider: "claude", execution_plan_digest: "digest",
        prompt: "input", output_schema: {}, timeout_ms: 1000, max_output_bytes: 1024, before_spawn })
      : spawnTaskSandbox({ argv: ["node"], cwd: ".", files: [], timeout_ms: 1000, max_output_bytes: 1024, before_spawn });
    const rejected = expect(pending).rejects.toMatchObject({ code: "CONTROL_APPROVAL_REVOKED" });
    await entered;
    expect(before_spawn).not.toHaveBeenCalled();
    authorized = false; release();
    await rejected;
    expect(before_spawn).toHaveBeenCalledTimes(1);
    expect(io.spawn).not.toHaveBeenCalled();
    expect(io.close).toHaveBeenCalledTimes(kind === "verifier" ? 1 : 0);
  });

  it.each(["provider", "verifier"])("counts %s preparation against the original deadline", async kind => {
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    io.prepare.mockImplementation(async () => { now = 1000; });
    const pending = kind === "provider"
      ? new ClaudeTaskCandidateProvider("/trusted/claude").generate({ provider: "claude", execution_plan_digest: "digest",
        prompt: "input", output_schema: {}, timeout_ms: 1000, max_output_bytes: 1024 })
      : spawnTaskSandbox({ argv: ["node"], cwd: ".", files: [], timeout_ms: 1000, max_output_bytes: 1024 });
    await expect(pending).rejects.toMatchObject({ code: kind === "provider" ? "TASK_PROVIDER_TIMEOUT" : "TASK_SANDBOX_TIMEOUT" });
    expect(io.spawn).not.toHaveBeenCalled();
  });

  it("uses the smaller current authority or monotonic deadline, including time spent checking", () => {
    let now = 300;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    expect(taskProcessTimeout(1000, () => 100, "TIMEOUT")).toBe(100);
    expect(taskProcessTimeout(1000, () => { now = 600; return 900; }, "TIMEOUT")).toBe(400);
    expect(() => taskProcessTimeout(1000, () => 0, "TIMEOUT")).toThrow("TIMEOUT");
  });
});
