import { recordTaskProviderUsage } from "./task-provider-usage.js";
import { JarvisError, type AuthorityDb } from "./db.js";
import type { ClaimedControlCommand } from "./control-plane.js";
import { ControlEffectAttempts } from "./control-effect-attempts.js";
import { assertTaskExecutionAuthority } from "./task-execution-authority.js";
import { LoopGraph } from "./loopgraph.js";
import { readTaskExecutionInputs, inspectTaskExecutionRepository, type TaskGitInspector } from "./task-execution-workspace.js";
import { prepareTaskProviderRequest, parseTaskProviderCandidate, type TaskCandidateProvider } from "./task-candidate-provider.js";
import { verifyTaskCandidate } from "./task-candidate-verification.js";
import { spawnTaskSandbox, type TaskSandboxRunner } from "./task-sandbox.js";
import type { TaskSpecV1 } from "./task-spec.js";
import { canonicalize } from "./canonical.js";
import { TaskCandidateArtifacts } from "./task-candidate-artifacts.js";
import { remainingTaskExecutionBudget, taskExecutionClockBudget } from "./task-execution-clock.js";

/** Candidate phase only: consumes an existing signed claim, but never publishes or settles a workflow as completed. */
export async function executeTaskCandidate(input: {
  authority: AuthorityDb; command: ClaimedControlCommand; provider: TaskCandidateProvider;
  clock?: () => Date; git?: TaskGitInspector; verifier?: TaskSandboxRunner;
}) {
  const { authority, provider } = input;
  const command = structuredClone(input.command);
  const clock = input.clock ?? (() => new Date());
  const currentPlan = () => authority.db.transaction(() => assertTaskExecutionAuthority(authority, command, clock())).immediate();
  const plan = currentPlan();
  if (provider.provider !== plan.provider) throw new JarvisError("TASK_PROVIDER_UNAVAILABLE");
  const run = new LoopGraph(authority).get(plan.run_id);
  const spec = (run.input as { task_spec: TaskSpecV1 }).task_spec;
  const source = await readTaskExecutionInputs(plan, input.git);
  const prepared = prepareTaskProviderRequest(plan, spec, source.files);
  currentPlan();
  const started = clock().getTime();
  const deadline = Math.min(started + plan.limits.timeout_ms, Date.parse(command.lease_expires_at));
  const monotonicDeadline = performance.now() + plan.limits.timeout_ms;
  const sharedBudget = taskExecutionClockBudget(plan.limits.timeout_ms);
  const remaining = () => {
    const value = Math.floor(Math.min(deadline - clock().getTime(), monotonicDeadline - performance.now(),
      remainingTaskExecutionBudget(sharedBudget)));
    if (!Number.isFinite(value) || value <= 0) throw new JarvisError("TASK_CANDIDATE_DEADLINE_EXCEEDED");
    return value;
  };
  remaining();
  const beforeSpawn = () => { currentPlan(); return remaining(); };
  const effects = new ControlEffectAttempts(authority);
  effects.prepareTask(command, clock);
  let invoking = false;
  let usageAttempted = false;
  try {
    effects.beginTaskInvocation(command, clock, sharedBudget);
    invoking = true;
    const generated = await provider.generate({ ...prepared.request, timeout_ms: remaining(), before_spawn: beforeSpawn });
    usageAttempted = true;
    recordTaskProviderUsage(authority, command, generated?.usage, true, clock());
    currentPlan(); remaining();
    if (!generated || !Number.isSafeInteger(generated.output_bytes) || generated.output_bytes < 0
      || generated.output_bytes < Buffer.byteLength(canonicalize(generated.output))) throw new JarvisError("TASK_PROVIDER_RESULT_INVALID");
    let outputBudget = plan.limits.max_output_bytes - generated.output_bytes;
    if (outputBudget < 0) throw new JarvisError("TASK_PROVIDER_OUTPUT_LIMIT");
    const files = parseTaskProviderCandidate(prepared, generated.output);
    const artifacts = new TaskCandidateArtifacts(authority);
    artifacts.save(command, { files, repository: source.check, provider_output_bytes: generated.output_bytes }, clock, remaining);
    await inspectTaskExecutionRepository(plan, input.git);
    currentPlan(); remaining();
    const verification = await verifyTaskCandidate(plan, files, async invocation => {
      currentPlan();
      const result = await (input.verifier ?? spawnTaskSandbox)({ ...invocation,
        before_spawn: beforeSpawn,
        timeout_ms: Math.min(invocation.timeout_ms, remaining()), max_output_bytes: Math.min(invocation.max_output_bytes, outputBudget) });
      currentPlan(); remaining();
      outputBudget -= result.stdout_bytes + result.stderr_bytes;
      if (outputBudget < 0) throw new JarvisError("TASK_SANDBOX_OUTPUT_LIMIT");
      return result;
    });
    currentPlan(); remaining();
    const artifact = artifacts.recordVerification(command, verification, clock, remaining);
    return { state: "candidate_checked" as const, request_id: command.request_id,
      repository: source.check, files, verification, artifact_id: artifact.artifact_id, published: false as const };
  } catch (error) {
    // Never reset a reservation or resend automatically after a possibly delivered provider call.
    if (invoking) {
      if (!usageAttempted) recordTaskProviderUsage(authority, command, undefined, false, clock());
      effects.markTaskUncertain(command, clock());
    }
    if (error instanceof JarvisError) throw error;
    throw new JarvisError("TASK_CANDIDATE_EXECUTION_FAILED");
  }
}
