import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { verifyTaskCandidate } from "../../src/task-candidate-verification.js";
import { taskSandboxArguments, type TaskSandboxResult } from "../../src/task-sandbox.js";
import { JarvisError } from "../../src/db.js";
import { executionPlan } from "../fixtures/task-execution-fixture.js";

const digest = (value: string) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const output = (patch: Partial<TaskSandboxResult> = {}): TaskSandboxResult => ({ exit_code: 0,
  stdout_bytes: 0, stderr_bytes: 0, stdout_digest: digest(""), stderr_digest: digest(""), ...patch });
function fixture() {
  const base = executionPlan();
  const plan = { ...base, files: base.files.map(file => ({ ...file })), limits: { ...base.limits },
    verification: base.verification.map(command => ({ ...command })) };
  plan.files[1]!.before_digest = digest("test-input");
  const files = [{ path: "src/fix.ts", content: Buffer.from("candidate") },
    { path: "tests/check.mjs", content: Buffer.from("test-input") }];
  return { plan, files };
}
afterEach(() => vi.restoreAllMocks());

describe("frozen candidate verification", () => {
  it("runs all declared checks on separate byte copies and binds only measured result fields", async () => {
    const { plan, files } = fixture();
    plan.verification.push({ id: "again", argv: ["node", "--check", "src/fix.ts"], cwd: ".", expected_exit: 0 });
    const seen: string[] = [];
    const result = await verifyTaskCandidate(plan, files, async input => {
      seen.push(input.files[0]!.content.toString());
      input.files[0]!.content.fill(0);
      files[0]!.content.fill(1);
      return { ...output(), hidden: "not an evidence field" };
    });
    expect(seen).toEqual(["candidate", "candidate"]);
    expect(result.state).toBe("checks_passed");
    expect(result.files[0]).toMatchObject({ digest: digest("candidate"), bytes: 9 });
    expect(result.checks.map(check => check.id)).toEqual(["focused", "again"]);
    expect(JSON.stringify(result)).not.toContain("not an evidence field");
  });

  it.each(["missing", "extra", "duplicate", "changed_read", "oversize"])("rejects %s before invoking any runner", async scenario => {
    const { plan, files } = fixture();
    if (scenario === "missing") files.pop();
    if (scenario === "extra") files.push({ path: "secret", content: Buffer.alloc(0) });
    if (scenario === "duplicate") files[1] = files[0]!;
    if (scenario === "changed_read") files[1]!.content = Buffer.from("modified-test");
    if (scenario === "oversize") files[0]!.content = Buffer.alloc(4 * 1024 * 1024 + 1);
    const runner = vi.fn(async () => output());
    await expect(verifyTaskCandidate(plan, files, runner)).rejects.toMatchObject({ code: "TASK_CANDIDATE_INPUT_INVALID" });
    expect(runner).not.toHaveBeenCalled();
  });

  it("stops on a failed command without completing the remaining checks", async () => {
    const { plan, files } = fixture();
    plan.verification.push({ ...plan.verification[0]!, id: "later" });
    const runner = vi.fn(async () => output({ exit_code: 2 }));
    const result = await verifyTaskCandidate(plan, files, runner);
    expect(result.state).toBe("checks_failed");
    expect(result.checks).toHaveLength(1);
    expect(runner).toHaveBeenCalledTimes(1);
  });

  it("applies one combined output budget across stdout, stderr and all commands", async () => {
    const { plan, files } = fixture();
    plan.limits.max_output_bytes = 1024;
    plan.verification.push({ ...plan.verification[0]!, id: "later" });
    const limits: number[] = [];
    await expect(verifyTaskCandidate(plan, files, async input => {
      limits.push(input.max_output_bytes);
      return output({ stdout_bytes: 400, stderr_bytes: 200 });
    })).rejects.toMatchObject({ code: "TASK_SANDBOX_OUTPUT_LIMIT" });
    expect(limits).toEqual([1024, 424]);
  });

  it("rejects a successful exit delivered after the shared deadline", async () => {
    const { plan, files } = fixture();
    plan.limits.timeout_ms = 1000;
    vi.spyOn(performance, "now").mockReturnValueOnce(0).mockReturnValueOnce(0).mockReturnValueOnce(1001);
    await expect(verifyTaskCandidate(plan, files, async () => output())).rejects.toMatchObject({ code: "TASK_SANDBOX_TIMEOUT" });
  });

  it.each(["unknown_error", "invalid_result"])("does not expose untrusted %s as evidence", async scenario => {
    const { plan, files } = fixture();
    await expect(verifyTaskCandidate(plan, files, async () => {
      if (scenario === "unknown_error") throw new Error("secret-runner-message");
      return output({ stdout_bytes: -1 });
    })).rejects.toMatchObject({ code: scenario === "unknown_error" ? "TASK_SANDBOX_FAILED" : "TASK_SANDBOX_RESULT_INVALID" });
  });

  it("preserves bounded runner failures without converting them to passed checks", async () => {
    const { plan, files } = fixture();
    await expect(verifyTaskCandidate(plan, files, async () => { throw new JarvisError("TASK_SANDBOX_TIMEOUT"); }))
      .rejects.toMatchObject({ code: "TASK_SANDBOX_TIMEOUT" });
  });

  it("constructs read-only data mounts and an isolated namespace without host workspace paths", () => {
    const { plan, files } = fixture();
    const args = taskSandboxArguments({ argv: plan.verification[0]!.argv, cwd: ".", files,
      timeout_ms: 1000, max_output_bytes: 1024 });
    expect(args).toEqual(expect.arrayContaining(["--unshare-all", "--unshare-user", "--disable-userns", "--clearenv", "--die-with-parent"]));
    expect(args.join(" ")).toContain("--ro-bind-data 4 /workspace/src/fix.ts");
    expect(args.join(" ")).toContain("--ro-bind-data 5 /workspace/tests/check.mjs");
    expect(args.join(" ")).toContain("--remount-ro / --chdir /workspace -- node tests/check.mjs");
    expect(args).not.toContain(plan.repository.root);
    expect(args).not.toContain("--share-net");
  });
});
