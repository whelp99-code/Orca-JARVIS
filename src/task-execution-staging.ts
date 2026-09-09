import { canonicalize } from "./canonical.js";
import { ControlPlane, type StoredControlCommand } from "./control-plane.js";
import { type AuthorityDb, JarvisError } from "./db.js";
import { LoopGraph } from "./loopgraph.js";
import { controlWorkflowRunInput } from "./control-workflow-input.js";
import { parseTaskExecutionPlan, taskExecutionPlanDigest, type TaskExecutionPlan } from "./task-execution-plan.js";
import { assertTaskTemplatePlan } from "./task-templates.js";
import { registeredTaskExecutor } from "./task-executor-registry.js";
import type { TaskSpecV1 } from "./task-spec-input.js";
import { MemoryProjectionAuthority } from "./memory-projection-authority.js";

export interface StageTaskExecutionInput {
  readonly request_id: string;
  readonly nonce: string;
  readonly requested_by: string;
  readonly plan: TaskExecutionPlan;
}

/** Recheck this binding again at execution; staging is neither approval nor provider readiness. */
export function assertTaskExecutionBinding(db: AuthorityDb, plan: TaskExecutionPlan, now: Date): void {
  if (new MemoryProjectionAuthority(db).isProjectionIdSuppressed(plan.task_id)) {
    throw new JarvisError("TASK_EXECUTION_SOURCE_SUPPRESSED");
  }
  const run = new LoopGraph(db).get(plan.run_id);
  if (!["running", "waiting_approval"].includes(run.state) || !Number.isFinite(now.getTime())) {
    throw new JarvisError("TASK_EXECUTION_WORKFLOW_NOT_READY");
  }
  const workflow = controlWorkflowRunInput({ ...run, budget: run.budget });
  const input = workflow.input as Record<string, unknown> | null;
  if (!input || input.task_id !== plan.task_id || input.task_spec_digest !== plan.task_spec_digest
    || !Object.hasOwn(input, "task_spec")) throw new JarvisError("TASK_EXECUTION_BINDING_INVALID");
  const routing = (input.task_spec as TaskSpecV1).routing;
  if (routing && registeredTaskExecutor(plan.provider)?.id !== routing.executor_id) {
    throw new JarvisError("TASK_ROUTING_EXECUTOR_MISMATCH");
  }
  const deadline = Date.parse(workflow.budget.deadline);
  if (!Number.isFinite(deadline) || deadline <= now.getTime()
    || !Number.isSafeInteger(workflow.budget.max_steps) || workflow.budget.max_steps <= run.attempts
    || workflow.budget.max_attempts_per_node < 1) throw new JarvisError("TASK_EXECUTION_BUDGET_EXHAUSTED");
  const starts = db.db.prepare(`SELECT r.args_json FROM control_command_requests r
    JOIN control_command_effects e ON e.request_id=r.request_id AND e.effect_type='workflow.started'
    JOIN control_command_redemptions x ON x.request_id=r.request_id AND x.lease_fence=r.lease_fence
    WHERE r.action='workflow.start' AND r.state='completed' AND json_extract(r.args_json,'$.run_id')=?`)
    .all(plan.run_id) as { args_json: string }[];
  const matches = starts.some(row => {
    const approved = controlWorkflowRunInput(JSON.parse(row.args_json));
    return approved.run_id === run.run_id && approved.loop_id === run.loop_id
      && approved.correlation_id === run.correlation_id && canonicalize(approved.input) === canonicalize(workflow.input)
      && canonicalize(approved.budget) === canonicalize(workflow.budget);
  });
  if (!matches) throw new JarvisError("TASK_EXECUTION_START_APPROVAL_REQUIRED");
  assertTaskTemplatePlan(input, plan);
}

export function stageTaskExecution(db: AuthorityDb, value: StageTaskExecutionInput, now = new Date()): StoredControlCommand {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).sort().join(",") !== "nonce,plan,request_id,requested_by"
    || ![value.request_id, value.nonce, value.requested_by].every(item =>
      typeof item === "string" && item.trim().length > 0 && item.length <= 160
      && [...item].every(character => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127))) {
    throw new JarvisError("TASK_EXECUTION_REQUEST_INVALID");
  }
  const plan = parseTaskExecutionPlan(value.plan);
  return db.db.transaction(() => {
    assertTaskExecutionBinding(db, plan, now);
    const args = { plan, execution_plan_digest: taskExecutionPlanDigest(plan) };
    const control = new ControlPlane(db);
    const prior = db.db.prepare("SELECT action,args_json,nonce,requested_by FROM control_command_requests WHERE request_id=?")
      .get(value.request_id) as Record<string, unknown> | undefined;
    if (prior) {
      if (prior.action !== "task.execute" || prior.args_json !== canonicalize(args)
        || prior.nonce !== value.nonce || prior.requested_by !== value.requested_by) {
        throw new JarvisError("TASK_EXECUTION_REPLAY_CONFLICT");
      }
      return control.get(value.request_id)!;
    }
    const run = new LoopGraph(db).get(plan.run_id);
    const deadline = Date.parse((run.budget as { deadline: string }).deadline);
    return control.stage({ schema_version: 1, request_id: value.request_id, action: "task.execute", action_level: 3,
      target: { environment: "local", run_id: plan.run_id, task_id: plan.task_id }, args, reversible: true,
      requested_by: value.requested_by, requested_at: now.toISOString(),
      expires_at: new Date(Math.min(now.getTime() + 15 * 60_000, deadline)).toISOString(), nonce: value.nonce }, now);
  }).immediate();
}
