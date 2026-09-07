import { isAbsolute } from "node:path";
import { JarvisError, type AuthorityDb } from "./db.js";
import type { TaskCandidateProvider } from "./task-candidate-provider.js";
import type { TaskCertificationDriver } from "./task-certified-execution.js";
import type { TaskExecutionPlan } from "./task-execution-plan.js";
import { ClaudeTaskCandidateProvider } from "./claude-task-provider.js";
import { NodeTaskVerifierProcess } from "./task-verifier-process.js";
import { taskCertificationVerifierKey } from "./task-certification-context.js";
import { readTaskExecutionClock } from "./task-execution-clock.js";
import { spawnTaskSandbox } from "./task-sandbox.js";
import { taskCompletionWorkflow } from "./task-completion-workflow.js";

export interface TaskExecutionRuntime {
  readonly provider: TaskCandidateProvider;
  readonly certification: TaskCertificationDriver;
  /** Local preparation only. This must never call a model or consume approval. */
  checkReady(): Promise<void>;
}

/** Host configuration only: request args cannot choose executables or verifier secrets. */
export function productionTaskExecutionRuntime(env: NodeJS.ProcessEnv = process.env): TaskExecutionRuntime | undefined {
  const path = env.JARVIS_TASK_CLAUDE_PATH;
  const keyPath = env.JARVIS_TASK_VERIFIER_KEY_PATH;
  const keyId = env.JARVIS_TASK_VERIFIER_KEY_ID;
  if (!path || !keyPath || !keyId) return undefined;
  const provider = new ClaudeTaskCandidateProvider(path);
  const verifier = new NodeTaskVerifierProcess(keyPath);
  return { provider, certification: { key_id: keyId, process: verifier }, checkReady: async () => {
    await provider.checkReady(); await verifier.checkReady(); readTaskExecutionClock();
    // Fixed code, no input files, credentials, network or workspace. No provider call for readiness.
    const probe = await spawnTaskSandbox({ argv: ["node", "-e", "process.exit(0)"], cwd: ".", files: [],
      timeout_ms: 5000, max_output_bytes: 4096 });
    if (probe.exit_code !== 0) throw new JarvisError("TASK_SANDBOX_UNAVAILABLE");
  } };
}

export async function assertTaskRuntimeReady(authority: AuthorityDb, plan: TaskExecutionPlan,
  runtime: TaskExecutionRuntime | undefined): Promise<TaskExecutionRuntime> {
  if (plan.schema_version !== 2) throw new JarvisError("TASK_COMPLETION_MODE_UNSUPPORTED");
  if (plan.provider !== "claude") throw new JarvisError("TASK_PROVIDER_UNSUPPORTED");
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
    await assertTaskRuntimeReady(authority, plan, productionTaskExecutionRuntime());
    taskCompletionWorkflow(authority, plan.run_id, clock());
    return { execution_available: true, readiness: { state: "ready", provider: plan.provider, authentication: "not_probed" } };
  } catch (error) {
    return { execution_available: false, readiness: { state: "unavailable", provider: plan.provider,
      authentication: "not_probed", reason_code: error instanceof JarvisError ? error.code : "TASK_EXECUTION_PREFLIGHT_FAILED" } };
  }
}
