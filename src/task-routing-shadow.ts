import { createHash } from "node:crypto";
import { canonicalize } from "./canonical.js";
import { ControlPlane, controlCommandDigest } from "./control-plane.js";
import { controlWorkflowRunInput } from "./control-workflow-input.js";
import { JarvisError, type AuthorityDb } from "./db.js";
import { parseTaskExecutionPlan, validateTaskExecutionAction } from "./task-execution-plan.js";
import { taskPerformanceWindow } from "./task-performance.js";
import { MemoryProjectionAuthority } from "./memory-projection-authority.js";
import { classifyWorkRouting } from "./work-routing.js";

type Decision = ReturnType<typeof classifyWorkRouting>;
function invalid(): never { throw new JarvisError("TASK_ROUTING_SOURCE_INVALID"); }
const probe = { schema_version: 1, objective: "policy validation" };
const hash = (value: unknown) => `sha256:${createHash("sha256").update("orca-jarvis/task-routing-shadow/v1\0")
  .update(canonicalize(value)).digest("hex")}`;
function targets(decision: Decision) {
  return decision.status !== "classified" ? null : {
    executors: [...decision.matches[0]!.proposed_executor_ids].sort(),
    stores: [...decision.matches[0]!.proposed_record_stores].sort(),
  };
}

/** Replay policies over historical input, not counterfactual execution outcomes.
 * Reads use current suppression checks; no historical approval grants authority. */
export function readTaskRoutingShadow(authority: AuthorityDb, from: unknown, to: unknown,
  baseline: unknown, candidate: unknown, observedAt = new Date()) {
  const window = taskPerformanceWindow(from, to, observedAt);
  const baselinePolicy = classifyWorkRouting(probe, baseline), candidatePolicy = classifyWorkRouting(probe, candidate);
  return authority.db.transaction(() => {
    new MemoryProjectionAuthority(authority).assertReady();
    const rows = authority.db.prepare(`SELECT request_id FROM control_command_requests
      WHERE action='task.execute' AND requested_at>=? AND requested_at<?
      ORDER BY requested_at,request_id LIMIT 1001`).all(window.from, window.to) as { request_id: string }[];
    if (rows.length > 1000) throw new JarvisError("TASK_PERFORMANCE_COHORT_LIMIT");
    const control = new ControlPlane(authority);
    let compared = 0, unavailable = 0, changedTargets = 0, unchangedTargets = 0;
    const transitions = { classified_to_classified: 0, classified_to_review: 0, review_to_classified: 0, review_to_review: 0 };
    const evidence: unknown[] = [];
    for (const row of rows) {
      let objective: unknown, sourceDigest: string;
      try {
        const command = control.get(row.request_id);
        if (!command || command.action !== "task.execute" || controlCommandDigest(command) !== command.command_digest) invalid();
        validateTaskExecutionAction(command);
        const plan = parseTaskExecutionPlan(command.args.plan);
        const starts = authority.db.prepare(`SELECT request_id FROM control_command_requests
          WHERE action='workflow.start' AND json_valid(args_json)
          AND json_extract(args_json,'$.run_id')=? ORDER BY request_id LIMIT 2`).all(plan.run_id) as { request_id: string }[];
        if (starts.length !== 1) invalid();
        const start = control.get(starts[0]!.request_id);
        if (!start || start.requested_at > command.requested_at || controlCommandDigest(start) !== start.command_digest) invalid();
        const workflow = controlWorkflowRunInput(start.args);
        const input = workflow.input as Record<string, unknown> | null;
        if (!input || input.task_id !== plan.task_id || input.task_spec_digest !== plan.task_spec_digest || !input.task_spec) invalid();
        objective = input.objective;
        sourceDigest = hash({ request: command.command_digest, source: start.command_digest, spec: plan.task_spec_digest });
        // Both policies must accept the same historical input before counting it.
        classifyWorkRouting({ schema_version: 1, objective }, baseline);
      } catch (error) {
        if (!(error instanceof SyntaxError) && (!(error instanceof JarvisError)
          || !["TASK_ROUTING_SOURCE_INVALID", "TASK_EXECUTION_PLAN_INVALID", "WORKFLOW_INPUT_INVALID",
            "TASK_SPEC_BINDING_INVALID", "WORK_ROUTING_INPUT_INVALID"].includes(error.code))) throw error;
        unavailable++;
        evidence.push({ request: hash(row.request_id), status: "input_unavailable" });
        continue;
      }
      const left = classifyWorkRouting({ schema_version: 1, objective }, baseline);
      const right = classifyWorkRouting({ schema_version: 1, objective }, candidate);
      const leftClassified = left.status === "classified", rightClassified = right.status === "classified";
      if (leftClassified && rightClassified) {
        transitions.classified_to_classified++;
        if (canonicalize(targets(left)) === canonicalize(targets(right))) unchangedTargets++; else changedTargets++;
      } else if (leftClassified) transitions.classified_to_review++;
      else if (rightClassified) transitions.review_to_classified++;
      else transitions.review_to_review++;
      compared++;
      evidence.push({ source_digest: sourceDigest!, baseline: left.decision_digest, candidate: right.decision_digest });
    }
    return { schema_version: 1, scope: "task.execute_request_cohort", window, mode: "historical_input_policy_replay",
      baseline_policy_digest: baselinePolicy.policy_digest, candidate_policy_digest: candidatePolicy.policy_digest,
      cohort_digest: hash(evidence), requests: rows.length, compared_requests: compared, unavailable_inputs: unavailable,
      coverage: rows.length === 0 ? null : compared / rows.length, transitions,
      classified_targets: { changed: changedTargets, unchanged: unchangedTargets },
      status: rows.length === 0 ? "no_requests" : unavailable ? "incomplete_inputs" : "compared",
      outcome_comparison: "unavailable_candidate_not_executed", baseline_is_deployed_policy: false,
      executable: false, policy_promoted: false };
  }).deferred();
}
