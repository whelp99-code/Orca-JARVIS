import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { executeTaskCandidate } from "../../src/task-candidate-execution.js";
import { stageTaskExecution } from "../../src/task-execution-staging.js";
import { LoopGraph } from "../../src/loopgraph.js";
import { taskExecutionFixture } from "../fixtures/task-execution-fixture.js";
import type { TaskProviderRequest } from "../../src/task-candidate-provider.js";
import type { TaskSandboxInvocation } from "../../src/task-sandbox.js";
import { TaskCandidateArtifacts } from "../../src/task-candidate-artifacts.js";

const digest = (value: string) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { vi.restoreAllMocks(); for (const release of cleanup.splice(0)) await release(); });
async function fixture() {
  const f = await taskExecutionFixture();
  const root = await mkdtemp(join(tmpdir(), "candidate-execution-"));
  cleanup.push(async () => { f.db.close(); await rm(root, { recursive: true, force: true }); });
  await mkdir(join(root, "src")); await mkdir(join(root, "tests"));
  await writeFile(join(root, "src/fix.ts"), "original"); await writeFile(join(root, "tests/check.mjs"), "check");
  const plan = { ...f.plan, provider: "claude" as const, repository: { ...f.plan.repository, root },
    files: [{ path: "src/fix.ts", access: "write" as const, before_digest: digest("original") },
      { path: "tests/check.mjs", access: "read" as const, before_digest: digest("check") }] };
  f.approve(stageTaskExecution(f.db, { ...f.request, plan }, f.now));
  const command = f.control.claim("execute", "candidate-worker", f.now);
  const generate = vi.fn(async (input: TaskProviderRequest) => {
    const output = { execution_plan_digest: input.execution_plan_digest, files: [{ path: "src/fix.ts", content: "changed" }] };
    return { output, output_bytes: Buffer.byteLength(JSON.stringify(output)) };
  });
  const provider = { provider: "claude" as const, generate };
  const verifier = vi.fn(async (input: TaskSandboxInvocation) => {
    input.before_spawn?.();
    return { exit_code: 0, stdout_bytes: 0, stderr_bytes: 0, stdout_digest: digest(""), stderr_digest: digest("") };
  });
  const git = async (path: string) => ({ root: await realpath(path), commit: plan.repository.baseline_commit });
  const state = () => f.db.db.prepare("SELECT state FROM control_effect_attempts").all();
  return { ...f, root, plan, command, provider, verifier, git, state,
    input: { authority: f.db, command, provider, verifier, git, clock: () => f.now } };
}

describe("approved task candidate execution", () => {
  it("preserves the provider candidate when the verifier fails, without recording a successful measurement", async () => {
    const f = await fixture();
    f.verifier.mockRejectedValue(new Error("verifier unavailable"));
    await expect(executeTaskCandidate(f.input)).rejects.toThrow("TASK_SANDBOX_FAILED");
    const saved = new TaskCandidateArtifacts(f.db).read("execute")!;
    expect(saved.files[0]!.content.toString()).toBe("changed");
    expect(saved.verification).toBeNull();
    expect(f.state()).toEqual([{ state: "uncertain" }]);
    expect(f.provider.generate).toHaveBeenCalledTimes(1);
  });
  it("does not extend the shared deadline when wall-clock time stops advancing", async () => {
    const f = await fixture();
    const actualNow = performance.now.bind(performance);
    let offset = 0;
    vi.spyOn(performance, "now").mockImplementation(() => actualNow() + offset);
    const original = f.provider.generate.getMockImplementation()!;
    f.provider.generate.mockImplementation(async input => {
      offset = f.plan.limits.timeout_ms + 1;
      return original(input);
    });
    await expect(executeTaskCandidate(f.input)).rejects.toMatchObject({ code: "TASK_CANDIDATE_DEADLINE_EXCEEDED" });
    expect(f.verifier).not.toHaveBeenCalled();
    expect(f.state()).toEqual([{ state: "uncertain" }]);
  });

  it.each(["provider_cancel", "provider_expire", "verifier_cancel", "verifier_expire"])(
    "rechecks signed authority at the actual %s spawn boundary", async scenario => {
      const f = await fixture();
      let now = f.now;
      let spawns = 0;
      const boundary = (input: { before_spawn?: () => number }) => {
        if (scenario.endsWith("cancel")) f.control.cancel({ request_id: "execute", actor: "operator", reason: "cancel",
          revoked_at: now.toISOString() }, now);
        else now = new Date(f.command.lease_expires_at);
        expect(input.before_spawn).toBeTypeOf("function");
        input.before_spawn!();
        spawns++;
      };
      if (scenario.startsWith("provider")) {
        const original = f.provider.generate.getMockImplementation()!;
        f.provider.generate.mockImplementation(async input => { boundary(input); return original(input); });
      } else {
        const original = f.verifier.getMockImplementation()!;
        f.verifier.mockImplementation(async input => { boundary(input); return original(input); });
      }
      await expect(executeTaskCandidate({ ...f.input, clock: () => now })).rejects.toThrow();
      expect(spawns).toBe(0);
      expect(f.state()).toEqual([{ state: "uncertain" }]);
    });

  it("connects one approved call to frozen verification without publishing or completing the workflow", async () => {
    const f = await fixture();
    const result = await executeTaskCandidate(f.input);
    expect(result).toMatchObject({ state: "candidate_checked", published: false, verification: { state: "checks_passed" } });
    expect(result.files.map(file => [file.path, file.content.toString()]))
      .toEqual([["src/fix.ts", "changed"], ["tests/check.mjs", "check"]]);
    const stored = new TaskCandidateArtifacts(f.db).read("execute")!;
    expect(stored.artifact_id).toBe(result.artifact_id);
    expect(stored.verification).toEqual(result.verification);
    const prompt = JSON.parse(f.provider.generate.mock.calls[0]![0].prompt);
    expect(prompt.task_spec).toEqual((f.workflow.input as { task_spec: unknown }).task_spec);
    expect(f.provider.generate).toHaveBeenCalledTimes(1);
    expect(f.verifier).toHaveBeenCalledTimes(1);
    expect(await readFile(join(f.root, "src/fix.ts"), "utf8")).toBe("original");
    expect(f.state()).toEqual([{ state: "invoking" }]);
    expect(f.control.get("execute")?.state).toBe("claimed");
    expect(new LoopGraph(f.db).get("run").state).toBe("running");
    f.approve(stageTaskExecution(f.db, { ...f.request, plan: f.plan, request_id: "again", nonce: "again" }, f.now));
    const command = f.control.claim("again", "another", f.now);
    await expect(executeTaskCandidate({ ...f.input, command })).rejects.toMatchObject({ code: "TASK_EXECUTION_ALREADY_BOUND" });
    expect(f.provider.generate).toHaveBeenCalledTimes(1);
  });

  it.each(["cancelled", "expired", "invalid_output", "provider_error", "source_changed", "oversize_output"])(
    "holds %s after the provider boundary without invoking verification", async scenario => {
      const f = await fixture();
      let now = f.now;
      const original = f.provider.generate.getMockImplementation()!;
      f.provider.generate.mockImplementation(async input => {
        if (scenario === "cancelled") f.control.cancel({ request_id: "execute", actor: "operator", reason: "cancel",
          revoked_at: now.toISOString() }, now);
        if (scenario === "expired") now = new Date(f.command.lease_expires_at);
        if (scenario === "provider_error") throw new Error("provider-secret");
        if (scenario === "source_changed") await writeFile(join(f.root, "src/fix.ts"), "concurrent");
        const result = await original(input);
        if (scenario === "invalid_output") result.output.files[0]!.path = "tests/check.mjs";
        if (scenario === "oversize_output") result.output_bytes = f.plan.limits.max_output_bytes + 1;
        return result;
      });
      await expect(executeTaskCandidate({ ...f.input, clock: () => now })).rejects.toThrow();
      expect(f.provider.generate).toHaveBeenCalledTimes(1);
      expect(f.verifier).not.toHaveBeenCalled();
      expect(f.state()).toEqual([{ state: "uncertain" }]);
    });

  it.each(["wrong_provider", "changed_source", "revoked"])("rejects %s before any reservation or provider call", async scenario => {
    const f = await fixture();
    if (scenario === "changed_source") await writeFile(join(f.root, "src/fix.ts"), "changed");
    if (scenario === "revoked") f.control.cancel({ request_id: "execute", actor: "operator", reason: "cancel",
      revoked_at: f.now.toISOString() }, f.now);
    const provider = scenario === "wrong_provider" ? { ...f.provider, provider: "codex" as const } : f.provider;
    await expect(executeTaskCandidate({ ...f.input, provider })).rejects.toThrow();
    expect(f.provider.generate).not.toHaveBeenCalled();
    expect(f.state()).toEqual([]);
  });
});
