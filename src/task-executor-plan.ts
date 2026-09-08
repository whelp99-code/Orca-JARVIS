import { JarvisError } from "./db.js";
import { parseTaskExecutionPlan, taskExecutionPlanDigest } from "./task-execution-plan.js";
import { inspectTaskExecutor, registeredTaskExecutor } from "./task-executor-registry.js";

/** The same structural contract is used by offline inspection and runtime preflight. */
export function parseRegisteredTaskExecutionPlan(value: unknown) {
  const plan = parseTaskExecutionPlan(value);
  if (plan.schema_version !== 2) throw new JarvisError("TASK_COMPLETION_MODE_UNSUPPORTED");
  const executor = registeredTaskExecutor(plan.provider);
  if (!executor) throw new JarvisError("TASK_PROVIDER_UNSUPPORTED");
  if (plan.schema_version !== executor.plan_schema_version || plan.mode !== executor.mode) {
    throw new JarvisError("TASK_COMPLETION_MODE_UNSUPPORTED");
  }
  return plan;
}

export function inspectTaskExecutorPlan(id: string, value: unknown) {
  const executor = inspectTaskExecutor(id, {});
  if (executor.registration !== "registered") throw new JarvisError("TASK_EXECUTOR_UNREGISTERED");
  const plan = parseRegisteredTaskExecutionPlan(value);
  if (plan.provider !== executor.descriptor.provider) throw new JarvisError("TASK_EXECUTOR_PLAN_MISMATCH");
  return { schema_version: 1, executor_id: id, input_valid: true, execution_plan_digest: taskExecutionPlanDigest(plan),
    execution_available: false, authority: "not_checked", repository: "not_checked",
    readiness: "not_probed", authentication: "not_probed" };
}
