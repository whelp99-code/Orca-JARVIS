import { type AuthorityDb, JarvisError } from "./db.js";
import { parseTaskExecutionPlan } from "./task-execution-plan.js";
import { assertTaskWorkLineage } from "./task-work-lineage-binding.js";
import { parseTaskWorkLineage } from "./task-work-lineage.js";
import { MemoryProjectionAuthority } from "./memory-projection-authority.js";
import { readControlCommand } from "./control-command-read.js";
import { controlCommandDigest } from "./control-plane-contract.js";
import { readTaskCompletionEvidence } from "./task-completion-evidence.js";

/** Request declarations, not inferred business outcomes or approval authority. */
export function readTaskWorkLineagePerformance(db: AuthorityDb,
  rows: readonly { request_id: string; requested_at: string; args_json: string }[], observedAt: Date) {
  const counts = { original: 0, rework: 0, retry: 0, unknown: 0, invalid: 0 };
  const completed = { original: 0, rework: 0, retry: 0, invalid_evidence: 0 };
  for (const row of rows) {
    try {
      const args = JSON.parse(row.args_json);
      if (!args || !Object.hasOwn(args, "work_lineage")) { counts.unknown++; continue; }
      const command = readControlCommand(db, row.request_id);
      if (!command || controlCommandDigest(command) !== command.command_digest) { counts.invalid++; continue; }
      const lineage = parseTaskWorkLineage(args.work_lineage);
      const plan = parseTaskExecutionPlan(args.plan);
      if (new MemoryProjectionAuthority(db).isProjectionIdSuppressed(plan.task_id)) { counts.invalid++; continue; }
      assertTaskWorkLineage(db, lineage, row.request_id, plan, row.requested_at);
      counts[lineage.kind]++;
      if (command.state === "completed") {
        try {
          const evidence = readTaskCompletionEvidence(db, row.request_id, observedAt);
          if (!evidence || !Number.isFinite(Date.parse(row.requested_at))
            || !Number.isFinite(Date.parse(evidence.completion.completed_at))
            || Date.parse(evidence.completion.completed_at) < Date.parse(row.requested_at)) completed.invalid_evidence++;
          else completed[lineage.kind]++;
        } catch (error) {
          if (!(error instanceof JarvisError) || error.code !== "TASK_COMPLETION_INVALID") throw error;
          completed.invalid_evidence++;
        }
      }
    } catch (error) {
      if (!(error instanceof SyntaxError) && !(error instanceof JarvisError &&
        ["TASK_WORK_LINEAGE_INVALID", "TASK_WORK_LINEAGE_BINDING_INVALID", "TASK_EXECUTION_PLAN_INVALID"].includes(error.code))) throw error;
      counts.invalid++;
    }
  }
  const denominator = counts.original + counts.rework;
  return { scope: "declared_request_relationships", counts, denominator,
    ratio: counts.unknown === 0 && counts.invalid === 0 && denominator > 0 ? counts.rework / denominator : null,
    status: counts.invalid ? "invalid_lineage" : counts.unknown ? "incomplete_coverage" : denominator ? "measured_declarations" : "no_business_requests",
    retries_in_denominator: false, verified_completions: completed,
    outcome_measurement: completed.invalid_evidence ? "invalid_completion_evidence" : "verified_completion_counts" };
}
