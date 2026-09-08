import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, it } from "vitest";
import { execute } from "../../src/cli.js";
import { inspectTaskExecutorPlan } from "../../src/task-executor-plan.js";
import { taskExecutionPlanDigest, type TaskExecutionPlanV2 } from "../../src/task-execution-plan.js";
import { executionPlan } from "../fixtures/task-execution-fixture.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function plan(): TaskExecutionPlanV2 {
  return { ...executionPlan(), provider: "claude", schema_version: 2, mode: "verified_git_commit",
    repository: { root: "/nonexistent/private-repository", baseline_commit: "a".repeat(40) },
    publication: { ref: "refs/heads/codex/private-result", repository_identity: `sha256:${"d".repeat(64)}` } };
}
function file() {
  const root = mkdtempSync(join(tmpdir(), "jarvis-executor-plan-")); roots.push(root);
  const path = join(root, "plan.json"); writeFileSync(path, JSON.stringify(plan()));
  return { root, path };
}

it("validates the compiled input contract without opening a DB or claiming readiness or authority", () => {
  const { root, path } = file();
  const output = execFileSync(process.execPath, [resolve("dist/src/cli.js"), "routing", "validate-plan", "claude-code", path], {
    cwd: root, env: { ...process.env, JARVIS_DB: join(root, "authority.sqlite") }, encoding: "utf8", timeout: 10000,
  });
  expect(JSON.parse(output)).toMatchObject({ ok: true, command: "routing.validate-plan", validation: {
    executor_id: "claude-code", input_valid: true, execution_plan_digest: taskExecutionPlanDigest(plan()),
    execution_available: false, authority: "not_checked", repository: "not_checked", readiness: "not_probed", authentication: "not_probed",
  } });
  expect(output).not.toContain("private-"); expect(output).not.toContain("src/fix.ts");
  expect(readdirSync(root)).toEqual(["plan.json"]);
});

it("rejects candidate-only plans, unsupported providers, unregistered IDs and malformed contracts", () => {
  expect(() => inspectTaskExecutorPlan("claude-code", executionPlan())).toThrow("TASK_COMPLETION_MODE_UNSUPPORTED");
  expect(() => inspectTaskExecutorPlan("claude-code", { ...plan(), provider: "codex" })).toThrow("TASK_PROVIDER_UNSUPPORTED");
  expect(() => inspectTaskExecutorPlan("cursor", plan())).toThrow("TASK_EXECUTOR_UNREGISTERED");
  expect(() => inspectTaskExecutorPlan("../claude", plan())).toThrow("TASK_EXECUTOR_INPUT_INVALID");
  for (const changed of [{ network: "allow" }, { files: [] }, { limits: { timeout_ms: 600001, max_output_bytes: 1024 } },
    { surprise: "private-data" }, { mode: "isolated_candidate" }]) {
    expect(() => inspectTaskExecutorPlan("claude-code", { ...plan(), ...changed })).toThrow("TASK_EXECUTION_PLAN_INVALID");
  }
});

it("binds validation to every plan field rather than treating the result as an execution ticket", () => {
  const input = plan(); const before = inspectTaskExecutorPlan("claude-code", input);
  const after = inspectTaskExecutorPlan("claude-code", { ...input, task_id: "different-task" });
  expect(before.execution_plan_digest).not.toBe(after.execution_plan_digest);
  expect(input).toEqual(plan());
});

it("rejects execution flags and bounded-file hazards in offline validation", async () => {
  const { root, path } = file(); const base = ["routing", "validate-plan", "claude-code"];
  for (const flags of [["--db", "/nonexistent/db"], ["--once"], ["extra"]]) {
    await expect(execute([...base, path, ...flags])).rejects.toMatchObject({ code: "WORK_ROUTING_INPUT_INVALID" });
  }
  const link = join(root, "link.json"), fifo = join(root, "fifo");
  symlinkSync(path, link); execFileSync("mkfifo", [fifo]);
  for (const invalid of [link, fifo]) await expect(execute([...base, invalid]))
    .rejects.toMatchObject({ code: "WORK_ROUTING_INPUT_INVALID" });
  for (const bytes of [Buffer.from([0xff]), Buffer.alloc(4 * 1024 * 1024 + 1, 32)]) {
    writeFileSync(path, bytes);
    await expect(execute([...base, path])).rejects.toMatchObject({ code: "WORK_ROUTING_INPUT_INVALID" });
  }
});
