import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { prepareTaskProviderRequest, parseTaskProviderCandidate } from "../../src/task-candidate-provider.js";
import { taskSpecDigest, type TaskSpecV1 } from "../../src/task-spec.js";
import { executionPlan } from "../fixtures/task-execution-fixture.js";
import { claudeTaskArguments } from "../../src/claude-task-provider.js";

const digest = (value: Buffer) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
function fixture() {
  const spec: TaskSpecV1 = { schema_version: 1, task_id: "task", objective: "Fix the selected module",
    requirements: { work_type: "development", constraints: ["no deployment"], completion_evidence: ["checks pass"] },
    assignments: [{ member_id: "builder", archetype: "builder", role: "Implement", scope: ["implement_changes"],
      exclusions: ["grant_authority"], verification: ["run_required_checks"], preferred_capability_ids: ["claude"] }],
    budget: { max_steps: 10, max_attempts_per_node: 2, deadline: "2026-09-08T23:00:00.000Z" } };
  const sources = [{ path: "src/fix.ts", content: Buffer.from("original") },
    { path: "tests/check.mjs", content: Buffer.from("test") }];
  const plan = { ...executionPlan(), provider: "claude" as const, task_spec_digest: taskSpecDigest(spec),
    files: executionPlan().files.map((file, index) => ({ ...file, before_digest: digest(sources[index]!.content) })) };
  const prepared = prepareTaskProviderRequest(plan, spec, sources);
  const output = { execution_plan_digest: prepared.request.execution_plan_digest, files: [{ path: "src/fix.ts", content: "candidate" }] };
  return { spec, sources, plan, prepared, output };
}

describe("task provider candidate contract", () => {
  it("preserves the complete approved specification and private read-only snapshot", () => {
    const f = fixture();
    f.sources[1]!.content.fill(0);
    expect(JSON.parse(f.prepared.request.prompt).task_spec).toEqual(f.spec);
    const result = parseTaskProviderCandidate(f.prepared, f.output);
    expect(result.map(file => file.content.toString())).toEqual(["candidate", "test"]);
    result[1]!.content.fill(0);
    expect(parseTaskProviderCandidate(f.prepared, f.output)[1]!.content.toString()).toBe("test");
    const args = claudeTaskArguments(f.prepared.request);
    expect(args.slice(args.indexOf("--tools"), args.indexOf("--tools") + 2)).toEqual(["--tools", ""]);
    expect(args).toEqual(expect.arrayContaining(["--safe-mode", "--strict-mcp-config", "mcp__*", "--no-session-persistence"]));
    expect(args).not.toContain("--dangerously-skip-permissions");
  });

  it.each(["digest", "absolute", "readonly", "duplicate", "missing", "extra", "surrogate", "oversize"])(
    "rejects provider %s output", scenario => {
      const { prepared, output } = fixture();
      if (scenario === "digest") output.execution_plan_digest = "wrong";
      if (scenario === "absolute") output.files[0]!.path = "/src/fix.ts";
      if (scenario === "readonly") output.files[0]!.path = "tests/check.mjs";
      if (scenario === "duplicate") output.files.push(output.files[0]!);
      if (scenario === "missing") output.files = [];
      if (scenario === "extra") Object.assign(output, { success: true });
      if (scenario === "surrogate") output.files[0]!.content = String.fromCharCode(0xd800);
      if (scenario === "oversize") output.files[0]!.content = "x".repeat(4 * 1024 * 1024 + 1);
      expect(() => parseTaskProviderCandidate(prepared, output)).toThrow("TASK_PROVIDER_RESULT_INVALID");
    });

  it.each(["changed", "binary", "context"])("rejects %s input without silently reducing the specification", scenario => {
    const f = fixture();
    f.sources[0]!.content = scenario === "binary" ? Buffer.from([0xff]) : Buffer.from("x".repeat(scenario === "context" ? 512 * 1024 : 1));
    if (scenario !== "changed") f.plan.files[0]!.before_digest = digest(f.sources[0]!.content);
    expect(() => prepareTaskProviderRequest(f.plan, f.spec, f.sources)).toThrow(scenario === "changed"
      ? "TASK_PROVIDER_INPUT_INVALID" : scenario === "binary" ? "TASK_PROVIDER_TEXT_REQUIRED" : "TASK_PROVIDER_CONTEXT_LIMIT");
  });
});
