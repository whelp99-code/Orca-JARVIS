import { expect, it, vi } from "vitest";
import { ControlPlane } from "../../src/control-plane.js";
import { LoopGraph } from "../../src/loopgraph.js";
import { readDashboardTaskExecution } from "../../src/dashboard/task-execution-read.js";
import { readDashboardTaskRouting } from "../../src/dashboard/task-routing-read.js";
import { classifyWorkRouting } from "../../src/work-routing.js";
import { approvedTaskFixture } from "../fixtures/approved-task-fixture.js";

const policy = { schema_version: 1, policy_id: "task-selection", revision: 1,
  rules: [{ id: "code", keywords: ["Fix"], executor_ids: ["claude-code"], record_stores: ["second-brain"] }] };
const routing = { schema_version: 1 as const, policy, executor_id: "claude-code",
  decision_digest: classifyWorkRouting({ schema_version: 1, objective: "Fix the selected module" }, policy).decision_digest };

it("projects the bound selection on runs and requests without policy text or database writes", async () => {
  const f = await approvedTaskFixture(true, { routing });
  try {
    const before = f.db.db.prepare("SELECT total_changes() AS n").get();
    const result = readDashboardTaskExecution(f.db, f.plan.task_id, f.clock());
    expect(result.runs[0]?.routing).toMatchObject({ executor_id: "claude-code", policy_id: "task-selection",
      policy_revision: 1, decision_digest: routing.decision_digest, task_spec_digest: f.plan.task_spec_digest,
      proposed_record_stores: ["second-brain"], authority: "display_only", delivery: "not_attested" });
    expect(result.requests[0]?.routing).toEqual(result.runs[0]?.routing);
    expect(JSON.stringify(result)).not.toContain('"keywords"');
    expect(JSON.stringify(result)).not.toContain("Fix the selected module");
    expect(f.db.db.prepare("SELECT total_changes() AS n").get()).toEqual(before);
    expect(f.generate).not.toHaveBeenCalled();
  } finally { await f.cleanup(); }
});

it("refuses a suppressed origin and a plan belonging to another selection", async () => {
  const f = await approvedTaskFixture(true, { routing });
  try {
    const run = new LoopGraph(f.db).get(f.plan.run_id);
    for (const change of [{ task_id: "another-task" }, { run_id: "another-run" },
      { task_spec_digest: `sha256:${"0".repeat(64)}` }, { provider: "codex" as const }]) {
      expect(() => readDashboardTaskRouting(f.db, run, { ...f.plan, ...change })).toThrow("TASK_ROUTING_DISPLAY_UNAVAILABLE");
    }
    const spy = vi.spyOn(ControlPlane.prototype, "get").mockReturnValue(undefined);
    try { expect(() => readDashboardTaskExecution(f.db, f.plan.task_id, f.clock())).toThrow("TASK_ROUTING_DISPLAY_UNAVAILABLE"); }
    finally { spy.mockRestore(); }
  } finally { await f.cleanup(); }
});

it("preserves responses for tasks with no routing selection", async () => {
  const f = await approvedTaskFixture();
  try {
    const result = readDashboardTaskExecution(f.db, f.plan.task_id, f.clock());
    expect(result.runs).toHaveLength(1); expect(result.requests).toHaveLength(1);
    expect(result.runs[0]).not.toHaveProperty("routing");
    expect(result.requests[0]).not.toHaveProperty("routing");
  } finally { await f.cleanup(); }
});

it("keeps ambiguous origin effects unavailable with the indexed lookup", async () => {
  const f = await approvedTaskFixture(true, { routing });
  try {
    f.db.db.prepare(`INSERT INTO control_command_effects(effect_id,request_id,effect_type,payload_json,payload_digest,created_at)
      SELECT 'duplicate-origin',request_id,effect_type,payload_json,payload_digest,created_at
      FROM control_command_effects WHERE request_id='start' AND effect_type='workflow.started' LIMIT 1`).run();
    const before = f.db.db.prepare("SELECT total_changes() AS n").get();
    expect(() => readDashboardTaskExecution(f.db, f.plan.task_id, f.clock())).toThrow("TASK_ROUTING_DISPLAY_UNAVAILABLE");
    expect(f.db.db.prepare("SELECT total_changes() AS n").get()).toEqual(before);
  } finally { await f.cleanup(); }
});
