import { canonicalize } from "../canonical.js";
import { ControlPlane, controlCommandDigest } from "../control-plane.js";
import { controlWorkflowRunInput } from "../control-workflow-input.js";
import { JarvisError, type AuthorityDb } from "../db.js";
import type { LoopGraph } from "../loopgraph.js";
import { registeredTaskExecutor } from "../task-executor-registry.js";
import type { TaskExecutionPlan } from "../task-execution-plan.js";
import type { TaskSpecV1 } from "../task-spec-input.js";
import { classifyWorkRouting } from "../work-routing.js";

/** Display-only projection of the original task selection. No policy body or
 * objective is returned, and historical records confer no current authority. */
export function readDashboardTaskRouting(db: AuthorityDb, run: ReturnType<LoopGraph["get"]>, plan?: TaskExecutionPlan) {
  const input = run.input as { task_spec?: TaskSpecV1; task_spec_digest?: string } | null;
  if (!input?.task_spec || !Object.hasOwn(input.task_spec, "routing")) return undefined;
  const fail = (): never => { throw new JarvisError("TASK_ROUTING_DISPLAY_UNAVAILABLE"); };
  const workflow = controlWorkflowRunInput({ ...run });
  const spec = input.task_spec, routing = spec.routing!;
  const rows = db.db.prepare(`SELECT r.request_id FROM control_command_requests r
    JOIN control_command_effects e ON e.request_id=r.request_id AND e.effect_type='workflow.started'
    WHERE r.action='workflow.start' AND r.state='completed' AND json_extract(r.args_json,'$.run_id')=?
    ORDER BY r.request_id LIMIT 2`).all(run.run_id) as { request_id: string }[];
  if (rows.length !== 1) return fail();
  const source = new ControlPlane(db).get(rows[0]!.request_id);
  if (!source || controlCommandDigest(source) !== source.command_digest) return fail();
  const original = controlWorkflowRunInput(source.args);
  if (canonicalize(original) !== canonicalize(workflow)
    || (plan && (plan.run_id !== run.run_id || plan.task_id !== spec.task_id || plan.task_spec_digest !== input.task_spec_digest
      || registeredTaskExecutor(plan.provider)?.id !== routing.executor_id))) return fail();
  const decision = classifyWorkRouting({ schema_version: 1, objective: spec.objective }, routing.policy);
  return { schema_version: 1 as const, executor_id: routing.executor_id,
    policy_id: decision.policy_id, policy_revision: decision.policy_revision, policy_digest: decision.policy_digest,
    decision_digest: routing.decision_digest, task_spec_digest: input.task_spec_digest!,
    rule_id: decision.matches[0]!.rule_id, proposed_record_stores: [...decision.matches[0]!.proposed_record_stores],
    authority: "display_only" as const, delivery: "not_attested" as const };
}

export type DashboardTaskRouting = NonNullable<ReturnType<typeof readDashboardTaskRouting>>;
