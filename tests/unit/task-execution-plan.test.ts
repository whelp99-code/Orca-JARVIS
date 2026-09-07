import { describe, expect, it } from "vitest";
import { parseTaskExecutionPlan, taskExecutionPlanDigest, validateTaskExecutionAction } from "../../src/task-execution-plan.js";
import { executionPlan } from "../fixtures/task-execution-fixture.js";

describe("machine-readable task execution plan", () => {
  it("binds v2 publication to an explicit new ref while keeping v1 candidate-only", () => {
    const prior = executionPlan();
    const next = { ...prior, schema_version: 2 as const, mode: "verified_git_commit" as const,
      publication: { ref: "refs/heads/codex/result", repository_identity: `sha256:${"a".repeat(64)}` } };
    expect(parseTaskExecutionPlan(next)).toEqual(next);
    expect(taskExecutionPlanDigest(next)).not.toBe(taskExecutionPlanDigest(prior));
    expect(taskExecutionPlanDigest({ ...next, publication: { ...next.publication, ref: "refs/heads/codex/other" } }))
      .not.toBe(taskExecutionPlanDigest(next));
    expect(taskExecutionPlanDigest({ ...next, publication: { ...next.publication, repository_identity: `sha256:${"b".repeat(64)}` } }))
      .not.toBe(taskExecutionPlanDigest(next));
    expect(() => parseTaskExecutionPlan({ ...prior, publication: next.publication })).toThrow();
    expect(() => parseTaskExecutionPlan({ ...next, schema_version: 1 })).toThrow();
    expect(() => parseTaskExecutionPlan({ ...next, publication: { ref: next.publication.ref } })).toThrow();
    expect(() => parseTaskExecutionPlan({ ...next, publication: { ...next.publication, repository_identity: "invalid" } })).toThrow();
  });

  it.each(["HEAD", "refs/heads/main", "refs/tags/release", "refs/heads/codex/../main", "refs/heads/codex/a.lock",
    "refs/heads/codex/a.", "refs/heads/codex/-x", "refs/heads/codex/a/b", "refs/heads/codex/x\ncreate other"])(
    "rejects publication ref %j", ref => {
      expect(() => parseTaskExecutionPlan({ ...executionPlan(), schema_version: 2, mode: "verified_git_commit",
        publication: { ref, repository_identity: `sha256:${"a".repeat(64)}` } })).toThrow();
    });
  it("binds every execution choice and returns an independent validated value", () => {
    const plan = executionPlan();
    const parsed = parseTaskExecutionPlan(plan);
    expect(parsed).toEqual(plan);
    expect(parsed).not.toBe(plan);
    const digest = taskExecutionPlanDigest(plan);
    for (const changed of [
      { ...plan, provider: "claude" as const },
      { ...plan, limits: { ...plan.limits, timeout_ms: 30_000 } },
      { ...plan, repository: { ...plan.repository, baseline_commit: "b".repeat(40) } },
      { ...plan, files: [{ ...plan.files[0]!, before_digest: null }, plan.files[1]!] },
      { ...plan, verification: [{ ...plan.verification[0]!, argv: ["node", "tests/other.mjs"] }] },
    ]) expect(taskExecutionPlanDigest(changed)).not.toBe(digest);
  });

  it.each(["../outside", "/absolute", "src//file", "src/./file", "src/../file", "src/*.ts", "src/[ab].ts",
    "src\\file", ".git/config", "nested/.GIT/config", "file\nname"])("rejects ambiguous file path %j", path => {
    const plan = executionPlan();
    expect(() => parseTaskExecutionPlan({ ...plan, files: [{ ...plan.files[0], path }] })).toThrow("TASK_EXECUTION_PLAN_INVALID");
  });

  it.each(["extra", "network", "mode", "baseline", "timeout", "no_checks", "shell_string", "check_cwd", "read_new",
    "duplicate", "parent_file", "no_writes"])("rejects invalid or unbounded %s", change => {
    const plan = structuredClone(executionPlan()) as unknown as Record<string, any>;
    if (change === "extra") plan.secret = "unexpected";
    if (change === "network") plan.network = "allow";
    if (change === "mode") plan.mode = "in_place";
    if (change === "baseline") plan.repository.baseline_commit = "main";
    if (change === "timeout") plan.limits.timeout_ms = Infinity;
    if (change === "no_checks") plan.verification = [];
    if (change === "shell_string") plan.verification[0].argv = "node tests/check.mjs";
    if (change === "check_cwd") plan.verification[0].cwd = "../outside";
    if (change === "read_new") plan.files[1].before_digest = null;
    if (change === "duplicate") plan.files.push(plan.files[0]);
    if (change === "parent_file") plan.files.push({ ...plan.files[0], path: "src" });
    if (change === "no_writes") plan.files[0].access = "read";
    expect(() => parseTaskExecutionPlan(plan)).toThrow("TASK_EXECUTION_PLAN_INVALID");
  });

  it("rejects target and digest substitution in the signed control action", () => {
    const plan = executionPlan();
    const input = { target: { environment: "local", run_id: "run", task_id: "task" },
      args: { plan, execution_plan_digest: taskExecutionPlanDigest(plan) } };
    expect(() => validateTaskExecutionAction(input)).not.toThrow();
    expect(() => validateTaskExecutionAction({ ...input, target: { ...input.target, task_id: "other" } })).toThrow();
    expect(() => validateTaskExecutionAction({ ...input, args: { ...input.args, plan: { ...plan, provider: "claude" } } })).toThrow();
  });
});
