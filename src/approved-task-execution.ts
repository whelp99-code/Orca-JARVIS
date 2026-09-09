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
import { MemoryProjectionAuthority } from "./memory-projection-authority.js";

export async function executeApprovedTaskRequest(input: { authority: AuthorityDb; request_id: string;
  worker: string; clock: () => Date; runtime?: TaskExecutionRuntime }): Promise<ApprovedExecutionResult> {
  const { authority, request_id: requestId, clock } = input;
  const control = new ControlPlane(authority);
  const { request, plan, previous } = authority.db.transaction(() => {
    const target = authority.db.prepare("SELECT target_json FROM control_command_requests WHERE request_id=? AND action='task.execute'")
      .get(requestId) as { target_json: string } | undefined;
    if (!target) throw new JarvisError("TASK_EXECUTION_REQUEST_INVALID");
    const taskId = JSON.parse(target.target_json)?.task_id;
    if (typeof taskId === "string" && new MemoryProjectionAuthority(authority).isProjectionIdSuppressed(taskId)) {
      throw new JarvisError("TASK_EXECUTION_SOURCE_SUPPRESSED");
    }
    const request = control.get(requestId);
    if (!request) throw new JarvisError("CONTROL_APPROVAL_REQUIRED");
    const plan = parseTaskExecutionPlan(request.args.plan);
    return { request, plan, previous: completedTaskExecution(authority, requestId) };
  }).deferred();
  if (previous) return previous;
  if (request.state !== "approved") throw new JarvisError("CONTROL_APPROVAL_REQUIRED");
  validateControlAction(request, { enforceMinimumLevel: true });
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
