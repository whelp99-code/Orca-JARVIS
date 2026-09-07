import { describe, expect, it } from "vitest";
import { controlWorkflowRunInput } from "../../src/control-workflow-input.js";
import { createTaskSpec, taskSpecDigest } from "../../src/task-spec.js";
import type { TeamProposalResultV1 } from "../../src/team-proposal.js";

const proposal: Extract<TeamProposalResultV1, { status: "ready" }> = {
  schema_version: 1, status: "ready", objective: "Fix the selected module", proposal_digest: `sha256:${"0".repeat(64)}`,
  requirements: { work_type: "development", constraints: ["no deployment"], completion_evidence: ["focused checks pass"] },
  members: [{
    member_id: "member_builder", archetype: "builder", role: "Implement changes", scope: ["implement_changes"],
    exclusions: ["grant_authority"], verification: ["run_required_checks"], preferred_capability_ids: ["codex"],
  }],
};
const budget = { max_steps: 10, max_attempts_per_node: 2, deadline: "2026-09-08T00:00:00.000Z" };
function command() {
  const spec = createTaskSpec("task", structuredClone(proposal), { ...budget });
  return {
    run_id: "run", loop_id: "agentops-default", correlation_id: "task", budget: { ...budget },
    input: {
      task_id: "task", objective: proposal.objective, members: structuredClone(proposal.members),
      task_spec: spec, task_spec_digest: taskSpecDigest(spec),
    },
  };
}

describe("approved task specification binding", () => {
  it("includes requirements, per-member boundaries, and budget in the stable digest", () => {
    const args = command();
    expect(controlWorkflowRunInput(args).input).toEqual(args.input);
    const prior = args.input.task_spec_digest;
    expect(taskSpecDigest({ ...args.input.task_spec, budget: { ...budget, max_steps: 11 } })).not.toBe(prior);
    const changed = structuredClone(args.input.task_spec);
    changed.assignments[0]!.exclusions = ["different restriction"];
    expect(taskSpecDigest(changed)).not.toBe(prior);
  });

  it.each(["constraints", "completion_evidence"] as const)("rejects %s changes after the digest is bound", field => {
    const args = command();
    args.input.task_spec = {
      ...args.input.task_spec, requirements: { ...args.input.task_spec.requirements, [field]: ["changed"] },
    };
    expect(() => controlWorkflowRunInput(args)).toThrow("TASK_SPEC_BINDING_INVALID");
  });

  it("rejects a changed execution budget even when the original task spec digest is valid", () => {
    const args = command();
    args.budget.max_steps++;
    expect(() => controlWorkflowRunInput(args)).toThrow("TASK_SPEC_BINDING_INVALID");
  });

  it("rejects a changed objective or member boundary outside the task spec", () => {
    const args = command();
    args.input.objective = "another objective";
    expect(() => controlWorkflowRunInput(args)).toThrow("TASK_SPEC_BINDING_INVALID");
    const members = command();
    members.input.members[0]!.exclusions = [];
    expect(() => controlWorkflowRunInput(members)).toThrow("TASK_SPEC_BINDING_INVALID");
  });

  it("rejects missing completion evidence even with a newly computed digest", () => {
    const args = command();
    args.input.task_spec = {
      ...args.input.task_spec, requirements: { ...args.input.task_spec.requirements, completion_evidence: [] },
    };
    args.input.task_spec_digest = taskSpecDigest(args.input.task_spec);
    expect(() => controlWorkflowRunInput(args)).toThrow("TASK_SPEC_BINDING_INVALID");
  });

  it("keeps legacy workflow inputs readable while rejecting partial new bindings", () => {
    const args = command();
    expect(controlWorkflowRunInput({ ...args, input: { task_id: "legacy" } }).input).toEqual({ task_id: "legacy" });
    for (const input of [{ task_spec: args.input.task_spec }, { task_spec_digest: args.input.task_spec_digest }]) {
      expect(() => controlWorkflowRunInput({ ...args, input })).toThrow("TASK_SPEC_BINDING_INVALID");
    }
  });
});
