import { TASK_FILE_LIMITS } from "./task-execution-limits.js";
import { createHash } from "node:crypto";
import { canonicalize } from "./canonical.js";
import { JarvisError } from "./db.js";
import { parseTaskExecutionPlan, taskExecutionPlanDigest, type TaskExecutionPlan } from "./task-execution-plan.js";
import { spawnTaskSandbox, type TaskSandboxFile, type TaskSandboxRunner, type TaskSandboxResult } from "./task-sandbox.js";

const hash = (value: string | Buffer) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
export type TaskCandidateVerification = {
  readonly state: "checks_passed" | "checks_failed";
  readonly execution_plan_digest: string; readonly candidate_digest: string;
  readonly files: readonly { readonly path: string; readonly digest: string; readonly bytes: number }[];
  readonly checks: readonly (TaskSandboxResult & { readonly id: string })[];
};

function candidateInputs(plan: TaskExecutionPlan, values: readonly TaskSandboxFile[]): TaskSandboxFile[] {
  const invalid = (): never => { throw new JarvisError("TASK_CANDIDATE_INPUT_INVALID"); };
  if (!Array.isArray(values) || values.length !== plan.files.length) return invalid();
  const provided = new Map<string, Buffer>();
  let total = 0;
  for (const value of values) {
    if (!value || typeof value.path !== "string" || !Buffer.isBuffer(value.content) || provided.has(value.path)
      || value.content.length > TASK_FILE_LIMITS.max_file_bytes) return invalid();
    total += value.content.length;
    if (total > TASK_FILE_LIMITS.max_total_bytes) return invalid();
    provided.set(value.path, Buffer.from(value.content));
  }
  return plan.files.map(file => {
    const content = provided.get(file.path);
    if (!content || (file.access === "read" && hash(content) !== file.before_digest)) return invalid();
    return { path: file.path, content };
  });
}

/** Executes verifier argv on a frozen, read-only byte snapshot. Does not approve, publish, sign, or settle a workflow. */
export async function verifyTaskCandidate(value: TaskExecutionPlan, values: readonly TaskSandboxFile[],
  runner: TaskSandboxRunner = spawnTaskSandbox): Promise<TaskCandidateVerification> {
  const { plan, frozen, files, execution_plan_digest, candidate_digest } = freezeTaskCandidate(value, values);
  return await runChecks(plan, frozen, files, execution_plan_digest, candidate_digest, runner);
}

/** Pure byte validation and identity construction, shared with durable candidate storage. */
export function freezeTaskCandidate(value: TaskExecutionPlan, values: readonly TaskSandboxFile[]) {
  const plan = parseTaskExecutionPlan(value);
  const frozen = candidateInputs(plan, values);
  const files = frozen.map(file => ({ path: file.path, digest: hash(file.content), bytes: file.content.length }));
  const execution_plan_digest = taskExecutionPlanDigest(plan);
  const candidate_digest = hash(canonicalize({ execution_plan_digest, files }));
  return { plan, frozen, files, execution_plan_digest, candidate_digest };
}

async function runChecks(plan: TaskExecutionPlan, frozen: TaskSandboxFile[], files: TaskCandidateVerification["files"],
  execution_plan_digest: string, candidate_digest: string, runner: TaskSandboxRunner): Promise<TaskCandidateVerification> {
  const checks: Array<TaskSandboxResult & { id: string }> = [];
  const deadline = performance.now() + plan.limits.timeout_ms;
  let remainingBytes = plan.limits.max_output_bytes;
  for (const command of plan.verification) {
    const remainingTime = Math.floor(deadline - performance.now());
    if (remainingTime <= 0) throw new JarvisError("TASK_SANDBOX_TIMEOUT");
    let result: TaskSandboxResult;
    try {
      result = await runner({ argv: [...command.argv], cwd: command.cwd,
        files: frozen.map(file => ({ path: file.path, content: Buffer.from(file.content) })),
        timeout_ms: remainingTime, max_output_bytes: remainingBytes });
    } catch (error) {
      if (error instanceof JarvisError && ["TASK_SANDBOX_PLATFORM_UNAVAILABLE", "TASK_SANDBOX_UNAVAILABLE",
        "TASK_SANDBOX_TIMEOUT", "TASK_SANDBOX_OUTPUT_LIMIT", "TASK_SANDBOX_INPUT_FAILED"].includes(error.code)) throw error;
      throw new JarvisError("TASK_SANDBOX_FAILED");
    }
    if (performance.now() >= deadline) throw new JarvisError("TASK_SANDBOX_TIMEOUT");
    if (!result || !Number.isSafeInteger(result.exit_code) || result.exit_code < -1 || result.exit_code > 255
      || ![result.stdout_bytes, result.stderr_bytes].every(bytes => Number.isSafeInteger(bytes) && bytes >= 0)
      || ![result.stdout_digest, result.stderr_digest].every(digest => /^sha256:[a-f0-9]{64}$/.test(digest))) {
      throw new JarvisError("TASK_SANDBOX_RESULT_INVALID");
    }
    remainingBytes -= result.stdout_bytes + result.stderr_bytes;
    if (remainingBytes < 0) throw new JarvisError("TASK_SANDBOX_OUTPUT_LIMIT");
    checks.push({ id: command.id, exit_code: result.exit_code, stdout_bytes: result.stdout_bytes,
      stderr_bytes: result.stderr_bytes, stdout_digest: result.stdout_digest, stderr_digest: result.stderr_digest });
    if (result.exit_code !== command.expected_exit) return { state: "checks_failed", execution_plan_digest, candidate_digest, files, checks };
  }
  return { state: "checks_passed", execution_plan_digest, candidate_digest, files, checks };
}
