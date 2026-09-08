import { ClaudeTaskCandidateProvider } from "./claude-task-provider.js";
import { NodeTaskVerifierProcess } from "./task-verifier-process.js";
import { readTaskExecutionClock } from "./task-execution-clock.js";
import { spawnTaskSandbox } from "./task-sandbox.js";
import { JarvisError } from "./db.js";
import type { TaskExecutionRuntime } from "./task-execution-runtime.js";

const CONFIGURATION = Object.freeze(["JARVIS_TASK_CLAUDE_PATH", "JARVIS_TASK_VERIFIER_KEY_PATH", "JARVIS_TASK_VERIFIER_KEY_ID"]);
const CLAUDE = Object.freeze({
  id: "claude-code", provider: "claude", plan_schema_version: 2, mode: "verified_git_commit",
  scope: "declared_repository_files", approval: "single_use_ed25519", verification: "independent_verifier",
  automatic_retry: false, required_configuration: CONFIGURATION,
} as const);

function createClaudeRuntime(env: NodeJS.ProcessEnv): TaskExecutionRuntime | undefined {
  const path = env.JARVIS_TASK_CLAUDE_PATH, keyPath = env.JARVIS_TASK_VERIFIER_KEY_PATH, keyId = env.JARVIS_TASK_VERIFIER_KEY_ID;
  if (!path || !keyPath || !keyId) return undefined;
  const provider = new ClaudeTaskCandidateProvider(path);
  const verifier = new NodeTaskVerifierProcess(keyPath);
  return { provider, certification: { key_id: keyId, process: verifier }, checkReady: async () => {
    await provider.checkReady(); await verifier.checkReady(); readTaskExecutionClock();
    const probe = await spawnTaskSandbox({ argv: ["node", "-e", "process.exit(0)"], cwd: ".", files: [],
      timeout_ms: 5000, max_output_bytes: 4096 });
    if (probe.exit_code !== 0) throw new JarvisError("TASK_SANDBOX_UNAVAILABLE");
  } };
}

// Factories are compiled host code. No request or policy payload can register a new executor.
const REGISTRATIONS = Object.freeze([Object.freeze({ descriptor: CLAUDE, create: createClaudeRuntime })]);

export function registeredTaskExecutor(provider: string) {
  return REGISTRATIONS.find(entry => entry.descriptor.provider === provider)?.descriptor;
}

export function createRegisteredTaskRuntime(provider: string, env: NodeJS.ProcessEnv): TaskExecutionRuntime | undefined {
  return REGISTRATIONS.find(entry => entry.descriptor.provider === provider)?.create(env);
}

export function inspectTaskExecutor(id: string, env: NodeJS.ProcessEnv = process.env) {
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(id)) throw new JarvisError("TASK_EXECUTOR_INPUT_INVALID");
  const entry = REGISTRATIONS.find(value => value.descriptor.id === id);
  const common = { schema_version: 1, id, execution_available: false, readiness: "not_probed", authentication: "not_probed" };
  if (!entry) return { ...common, registration: "unregistered" as const };
  const missing_configuration = entry.descriptor.required_configuration.filter(key => !env[key]);
  return { ...common, registration: "registered" as const, descriptor: entry.descriptor,
    configuration: missing_configuration.length === 0 ? "present" : "missing", missing_configuration };
}

export function inspectTaskExecutors(env: NodeJS.ProcessEnv = process.env) {
  return REGISTRATIONS.map(entry => inspectTaskExecutor(entry.descriptor.id, env));
}
