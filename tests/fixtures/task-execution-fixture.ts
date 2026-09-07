import { ApprovedCommandExecutor, ControlPlane, signCommandApproval } from "../../src/index.js";
import { LoopGraph } from "../../src/loopgraph.js";
import type { StoredControlCommand } from "../../src/control-plane.js";
import { createTaskSpec, taskSpecDigest } from "../../src/task-spec.js";
import type { TaskExecutionPlanV1 } from "../../src/task-execution-plan.js";
import { initialized, localKey } from "../helpers.js";

export function executionPlan(): TaskExecutionPlanV1 {
  return { schema_version: 1, run_id: "run", task_id: "task", task_spec_digest: `sha256:${"a".repeat(64)}`,
    provider: "codex", mode: "isolated_candidate", repository: { root: process.cwd(), baseline_commit: "a".repeat(40) },
    files: [{ path: "src/fix.ts", access: "write", before_digest: `sha256:${"b".repeat(64)}` },
      { path: "tests/check.mjs", access: "read", before_digest: `sha256:${"c".repeat(64)}` }],
    network: "deny", limits: { timeout_ms: 60_000, max_output_bytes: 65536 },
    verification: [{ id: "focused", argv: ["node", "tests/check.mjs"], cwd: ".", expected_exit: 0 }] };
}

export async function taskExecutionFixture(approvedStart = true) {
  const db = await initialized();
  const control = new ControlPlane(db);
  const now = new Date();
  const budget = { max_steps: 10, max_attempts_per_node: 2, deadline: new Date(now.getTime() + 600_000).toISOString() };
  const proposal = { schema_version: 1 as const, status: "ready" as const, objective: "Fix the selected module",
    proposal_digest: `sha256:${"0".repeat(64)}`,
    requirements: { work_type: "development" as const, constraints: ["no deployment"], completion_evidence: ["focused checks pass"] },
    members: [{ member_id: "builder", archetype: "builder" as const, role: "Implement changes", scope: ["implement_changes"],
      exclusions: ["grant_authority"], verification: ["run_required_checks"], preferred_capability_ids: ["codex" as const] }] };
  const spec = createTaskSpec("task", proposal, budget);
  const workflow = { run_id: "run", loop_id: "agentops-default", correlation_id: "task", budget,
    input: { task_id: "task", objective: spec.objective, members: proposal.members, task_spec: spec,
      task_spec_digest: taskSpecDigest(spec) } };
  const graph = new LoopGraph(db);
  graph.ensureDefaults(now);
  const approve = (request: StoredControlCommand) => {
    control.decide(signCommandApproval({ schema_version: 1, receipt_id: `approve:${request.request_id}`,
      request_id: request.request_id, decision: "approve", command_digest: request.command_digest,
      signer_principal_id: "test-operator", authenticated_session_id: "external-test-approval", key_id: "decision-test",
      algorithm: "Ed25519", issued_at: now.toISOString(), not_before: now.toISOString(), expires_at: budget.deadline,
      nonce: `approve-nonce:${request.request_id}`, max_uses: 1, status: "issued" }, localKey(db)), now);
  };
  if (approvedStart) {
    const request = control.stage({ schema_version: 1, request_id: "start", action: "workflow.start", action_level: 2,
      target: { environment: "local", run_id: "run", task_id: "task" }, args: workflow, reversible: true,
      requested_by: "test-operator", requested_at: now.toISOString(), expires_at: budget.deadline, nonce: "start-nonce" }, now);
    approve(request);
    const result = await new ApprovedCommandExecutor(db, undefined, undefined, {}, () => now).execute("start", "fixture", now);
    if (result.state !== "completed") throw new Error("workflow setup failed");
  } else graph.start(workflow, now);
  const plan = { ...executionPlan(), task_spec_digest: taskSpecDigest(spec) };
  return { db, control, now, plan, workflow, approve,
    request: { request_id: "execute", nonce: "execute-nonce", requested_by: "test-operator", plan } };
}
