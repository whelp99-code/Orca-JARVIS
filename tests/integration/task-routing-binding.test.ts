import { expect, it } from "vitest";
import { classifyWorkRouting } from "../../src/work-routing.js";
import { parseTaskRoutingBinding } from "../../src/task-routing-binding.js";
import { assertTaskExecutionBinding, stageTaskExecution } from "../../src/task-execution-staging.js";
import { readTaskCompletionEvidence } from "../../src/task-completion-evidence.js";
import { taskSpecDigest } from "../../src/task-spec-input.js";
import { approvedTaskFixture } from "../fixtures/approved-task-fixture.js";

const objective = "Fix the selected module";
const policy = { schema_version: 1, policy_id: "task-selection", revision: 1,
  rules: [{ id: "code", keywords: ["Fix"], executor_ids: ["claude-code"], record_stores: ["second-brain"] }] };
function binding() { return { schema_version: 1 as const, policy,
  decision_digest: classifyWorkRouting({ schema_version: 1, objective }, policy).decision_digest, executor_id: "claude-code" }; }

it("binds policy, decision and selected executor without accepting conflicts or stale decisions", () => {
  const route = binding();
  expect(parseTaskRoutingBinding(route, objective)).toEqual(route);
  expect(() => parseTaskRoutingBinding({ ...route, extra: true }, objective)).toThrow("TASK_ROUTING_BINDING_INVALID");
  expect(() => parseTaskRoutingBinding({ ...route, executor_id: "codex" }, objective)).toThrow("TASK_ROUTING_BINDING_INVALID");
  expect(() => parseTaskRoutingBinding({ ...route, policy: { ...policy, revision: 2 } }, objective)).toThrow("TASK_ROUTING_BINDING_INVALID");
  expect(() => parseTaskRoutingBinding(route, "another objective")).toThrow("TASK_ROUTING_REVIEW_REQUIRED");
  expect(() => parseTaskRoutingBinding({ ...route, policy: { ...policy,
    rules: [...policy.rules, { ...policy.rules[0]!, id: "other" }] } }, objective)).toThrow("TASK_ROUTING_REVIEW_REQUIRED");
});

it("carries routing through approved workflow, execution and verified completion without replaying effects", async () => {
  const f = await approvedTaskFixture(true, { routing: binding() });
  try {
    const spec = f.workflow.input.task_spec;
    expect(spec.routing).toEqual(binding());
    const { routing: _routing, ...legacy } = spec;
    expect(_routing).toEqual(binding());
    expect(taskSpecDigest(spec)).not.toBe(taskSpecDigest(legacy));
    expect(f.plan.task_spec_digest).toBe(taskSpecDigest(spec));
    expect((await f.executor.execute("execute", "routed-task", f.clock())).state).toBe("completed");
    expect(readTaskCompletionEvidence(f.db, "execute", f.clock())).toBeDefined();
    expect((await f.executor.execute("execute", "routed-task-replay", f.clock())).state).toBe("completed");
    expect(f.generate).toHaveBeenCalledTimes(1); expect(f.verify).toHaveBeenCalledTimes(1);
  } finally { await f.cleanup(); }
});

it("rejects a provider that differs from the approved selected executor before dispatch or staging", async () => {
  const f = await approvedTaskFixture(true, { routing: binding(), stage: false });
  try {
    const plan = { ...f.plan, provider: "codex" as const };
    const before = f.db.db.prepare("SELECT total_changes() AS n").get();
    expect(() => assertTaskExecutionBinding(f.db, plan, f.clock())).toThrow("TASK_ROUTING_EXECUTOR_MISMATCH");
    expect(() => stageTaskExecution(f.db, { ...f.request, plan }, f.clock())).toThrow("TASK_ROUTING_EXECUTOR_MISMATCH");
    expect(f.db.db.prepare("SELECT total_changes() AS n").get()).toEqual(before);
    expect(f.generate).not.toHaveBeenCalled(); expect(f.verify).not.toHaveBeenCalled();
  } finally { await f.cleanup(); }
});
