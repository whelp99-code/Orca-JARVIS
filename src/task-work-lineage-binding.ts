import { type AuthorityDb, JarvisError } from "./db.js";
import { parseTaskExecutionPlan, type TaskExecutionPlan } from "./task-execution-plan.js";
import { parseTaskWorkLineage } from "./task-work-lineage.js";
import { MemoryProjectionAuthority } from "./memory-projection-authority.js";
import { readControlCommand } from "./control-command-read.js";
import { controlCommandDigest } from "./control-plane-contract.js";
import { visibleTaskWorkLineage } from "./task-work-lineage-visibility.js";

/** A declared business relationship does not authorize execution or certify its outcome. */
export function assertTaskWorkLineage(db: AuthorityDb, value: unknown, requestId: string,
  plan: TaskExecutionPlan, requestedAt: string): void {
  const lineage = parseTaskWorkLineage(value);
  if (lineage.kind === "original") return;
  const invalid = (): never => { throw new JarvisError("TASK_WORK_LINEAGE_BINDING_INVALID"); };
  if (lineage.prior_request_id === requestId || plan.schema_version !== 2) return invalid();
  if (!visibleTaskWorkLineage(db, { action: "task.execute", requested_at: requestedAt,
    args_json: JSON.stringify({ work_lineage: lineage }) }, new MemoryProjectionAuthority(db))) return invalid();
  const prior = readControlCommand(db, lineage.prior_request_id);
  if (!prior || prior.action !== "task.execute" || prior.command_digest !== lineage.prior_command_digest
    || controlCommandDigest(prior) !== prior.command_digest || prior.requested_at >= requestedAt) return invalid();
  const priorPlan = parseTaskExecutionPlan(prior.args.plan);
  if (priorPlan.schema_version !== 2 || priorPlan.publication.repository_identity !== plan.publication.repository_identity
    || new MemoryProjectionAuthority(db).isProjectionIdSuppressed(priorPlan.task_id)) return invalid();
}
