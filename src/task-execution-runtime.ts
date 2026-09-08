import { isAbsolute } from "node:path";
import { JarvisError, type AuthorityDb } from "./db.js";
import type { TaskCandidateProvider } from "./task-candidate-provider.js";
import type { TaskCertificationDriver } from "./task-certified-execution.js";
import type { TaskExecutionPlan } from "./task-execution-plan.js";
import { taskCertificationVerifierKey } from "./task-certification-context.js";
import { taskCompletionWorkflow } from "./task-completion-workflow.js";
import { createRegisteredTaskRuntime } from "./task-executor-registry.js";
import { parseRegisteredTaskExecutionPlan } from "./task-executor-plan.js";

export interface TaskExecutionRuntime {
  readonly provider: TaskCandidateProvider;
  readonly certification: TaskCertificationDriver;
  /** Local preparation only. This must never call a model or consume approval. */
  checkReady(): Promise<void>;
}

/** Host configuration only: request args cannot choose executables or verifier secrets. */
export function productionTaskExecutionRuntime(env: NodeJS.ProcessEnv = process.env,
  provider: string = "claude"): TaskExecutionRuntime | undefined {
  return createRegisteredTaskRuntime(provider, env);
}

export async function assertTaskRuntimeReady(authority: AuthorityDb, plan: TaskExecutionPlan,
  runtime: TaskExecutionRuntime | undefined): Promise<TaskExecutionRuntime> {
  plan = parseRegisteredTaskExecutionPlan(plan);
  if (!runtime) throw new JarvisError("TASK_EXECUTION_NOT_CONFIGURED");
  if (runtime.provider.provider !== plan.provider) throw new JarvisError("TASK_PROVIDER_UNAVAILABLE");
  const main = (authority.db.prepare("PRAGMA database_list").all() as Array<{ name: string; file: string }>).find(row => row.name === "main");
  if (!main || !isAbsolute(main.file)) throw new JarvisError("TASK_VERIFIER_DATABASE_UNAVAILABLE");
  taskCertificationVerifierKey(authority, runtime.certification.key_id);
  try { await runtime.checkReady(); }
  catch (error) { if (error instanceof JarvisError) throw error; throw new JarvisError("TASK_EXECUTION_PREFLIGHT_FAILED"); }
  taskCertificationVerifierKey(authority, runtime.certification.key_id);
  return runtime;
}

export async function taskExecutionReadiness(authority: AuthorityDb, plan: TaskExecutionPlan, clock: () => Date) {
  try {
    taskCompletionWorkflow(authority, plan.run_id, clock());
    await assertTaskRuntimeReady(authority, plan, productionTaskExecutionRuntime(process.env, plan.provider));
    taskCompletionWorkflow(authority, plan.run_id, clock());
    return { execution_available: true, readiness: { state: "ready", provider: plan.provider, authentication: "not_probed" } };
  } catch (error) {
    return { execution_available: false, readiness: { state: "unavailable", provider: plan.provider,
      authentication: "not_probed", reason_code: error instanceof JarvisError ? error.code : "TASK_EXECUTION_PREFLIGHT_FAILED" } };
  }
}
