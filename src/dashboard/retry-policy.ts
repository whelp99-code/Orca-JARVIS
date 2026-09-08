import { controlActionDescriptor } from "../control-actions.js";
import type { StoredControlCommand } from "../control-plane.js";
import { controlWorkflowRunInput } from "../control-workflow-input.js";
import { JarvisError } from "../db.js";
import type { OverviewApproval } from "./legacy-read-contracts.js";

/** Read-time guidance only; the POST boundary must evaluate it again. */
export function dashboardRetryStatus(
  source: Pick<StoredControlCommand, "action" | "state" | "args"> | undefined,
  now: Date,
): NonNullable<OverviewApproval["retry_status"]> {
  if (source?.state !== "failed" || source.action === "task.execute" || controlActionDescriptor(source.action)?.executable !== true
    || !Number.isFinite(now.getTime())) return "not_allowed";
  if (source.action !== "workflow.start") return "allowed";
  try {
    const { budget } = controlWorkflowRunInput(source.args);
    const deadline = Date.parse(budget.deadline);
    if (!Number.isFinite(deadline) || deadline <= now.getTime()
      || budget.max_steps < 1 || budget.max_attempts_per_node < 1) return "replan_required";
    return "allowed";
  } catch (error) {
    if (error instanceof JarvisError
      && ["WORKFLOW_INPUT_INVALID", "TASK_SPEC_BINDING_INVALID"].includes(error.code)) return "replan_required";
    throw error;
  }
}
