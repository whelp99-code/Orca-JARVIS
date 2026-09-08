import type { ApprovedExecutionResult } from "./approved-executor-types.js";
import { ControlPlane } from "./control-plane.js";
import { validateControlAction } from "./control-actions.js";
import { JarvisError, type AuthorityDb } from "./db.js";
import { parseTaskExecutionPlan } from "./task-execution-plan.js";
import { assertTaskExecutionBinding } from "./task-execution-staging.js";
import { taskCompletionWorkflow } from "./task-completion-workflow.js";
import { executeTaskWorkflow } from "./task-completion.js";
import { completedTaskExecution, settleApprovedTaskError } from "./approved-task-outcome.js";
import { assertTaskRuntimeReady, productionTaskExecutionRuntime, type TaskExecutionRuntime } from "./task-execution-runtime.js";

export async function executeApprovedTaskRequest(input: { authority: AuthorityDb; request_id: string;
  worker: string; clock: () => Date; runtime?: TaskExecutionRuntime }): Promise<ApprovedExecutionResult> {
  const { authority, request_id: requestId, clock } = input;
  const control = new ControlPlane(authority); const request = control.get(requestId);
  if (!request || request.action !== "task.execute") throw new JarvisError("TASK_EXECUTION_REQUEST_INVALID");
  const previous = completedTaskExecution(authority, requestId); if (previous) return previous;
  if (request.state !== "approved") throw new JarvisError("CONTROL_APPROVAL_REQUIRED");
  validateControlAction(request, { enforceMinimumLevel: true });
  const plan = parseTaskExecutionPlan(request.args.plan);
  const check = () => { const now = clock(); assertTaskExecutionBinding(authority, plan, now);
    taskCompletionWorkflow(authority, plan.run_id, now); };
  check();
  const runtime = await assertTaskRuntimeReady(authority, plan, input.runtime ?? productionTaskExecutionRuntime(process.env, plan.provider));
  check();
  const command = control.claim(requestId, input.worker, clock(), plan.limits.timeout_ms);
  let result: Awaited<ReturnType<typeof executeTaskWorkflow>>;
  try {
    result = await executeTaskWorkflow({ authority, command, provider: runtime.provider,
      certification: runtime.certification, clock });
  } catch (error) {
    const code = error instanceof JarvisError ? error.code : "TASK_EXECUTION_UNCERTAIN";
    return settleApprovedTaskError(authority, command, code, false, clock);
  }
  if (result.state === "completed") return { request_id: requestId, action: command.action, state: "completed", result };
  return settleApprovedTaskError(authority, command, "TASK_CHECKS_FAILED", true, clock);
}
