import { JarvisError, type AuthorityDb } from "./db.js";
import { isAbsolute } from "node:path";
import type { ClaimedControlCommand } from "./control-plane.js";
import { ControlEffectAttempts } from "./control-effect-attempts.js";
import { assertTaskExecutionAuthority } from "./task-execution-authority.js";
import { taskCertificationVerifierKey } from "./task-certification-context.js";
import { TaskCandidateCertifications } from "./task-candidate-certifications.js";
import { executeTaskCandidate } from "./task-candidate-execution.js";
import type { TaskVerifierProcess } from "./task-verifier-process.js";
import { parseTaskExecutionPlan } from "./task-execution-plan.js";
import { publishTaskGitCandidate } from "./task-git-publication.js";

export type TaskCertificationDriver = { readonly key_id: string; readonly process: TaskVerifierProcess };

function verifierDatabase(authority: AuthorityDb): string {
  const databases = authority.db.prepare("PRAGMA database_list").all() as Array<{ name: string; file: string }>;
  const path = databases.find(database => database.name === "main")?.file;
  if (!path || !isAbsolute(path)) throw new JarvisError("TASK_VERIFIER_DATABASE_UNAVAILABLE");
  return path;
}

/** Reserve once, launch the independent verifier, validate and persist its result; never replay on failure. */
export async function certifyTaskCandidate(input: { authority: AuthorityDb; command: ClaimedControlCommand;
  certification: TaskCertificationDriver; clock?: () => Date }) {
  const { authority, certification } = input;
  const command = structuredClone(input.command);
  const clock = input.clock ?? (() => new Date());
  const database = verifierDatabase(authority);
  const certs = new TaskCandidateCertifications(authority);
  const request = certs.prepare(command, certification.key_id, clock);
  try {
    const remaining = () => certs.pending(command, request.verification_id, clock).remaining_ms;
    const value = await certification.process.verify({ database, command,
      verification_id: request.verification_id, timeout_ms: remaining(), before_spawn: remaining });
    if (!value || typeof value !== "object" || !("invocation_id" in value) || typeof value.invocation_id !== "string") {
      throw new JarvisError("TASK_VERIFIER_RESULT_INVALID");
    }
    const proof = certs.record(command, request.verification_id, value.invocation_id, value, clock);
    return { verification_id: request.verification_id, artifact_id: request.artifact_id, proof, published: false as const };
  } catch (error) {
    // We own this reservation. The production runner waits for child close before rejecting.
    // Keep its reserved/running/uncertain evidence and prevent the operation from publishing or being replayed.
    new ControlEffectAttempts(authority).markTaskUncertain(command, clock());
    if (error instanceof JarvisError) throw error;
    throw new JarvisError("TASK_CERTIFIED_EXECUTION_FAILED");
  }
}

/** One call through candidate generation and independent certification. Publication and workflow settlement are separate. */
export async function executeCertifiedTaskCandidate(input: Parameters<typeof executeTaskCandidate>[0]
  & { certification: TaskCertificationDriver }) {
  const command = structuredClone(input.command);
  const clock = input.clock ?? (() => new Date());
  verifierDatabase(input.authority);
  const check = () => input.authority.db.transaction(() => {
    assertTaskExecutionAuthority(input.authority, command, clock());
    taskCertificationVerifierKey(input.authority, input.certification.key_id);
  }).immediate();
  check();
  await input.certification.process.checkReady();
  check();
  const candidate = await executeTaskCandidate({ ...input, command });
  const certified = await certifyTaskCandidate({ authority: input.authority, command, certification: input.certification, clock });
  return { ...candidate, state: "candidate_certified" as const, certification: certified.proof,
    verification_id: certified.verification_id,
    checks_passed: candidate.verification.state === "checks_passed" && certified.proof.measurement.state === "checks_passed" };
}

/** Execute the explicitly approved output mode; a v1 candidate never acquires Git publication authority. */
export async function executeTaskPlan(input: Parameters<typeof executeCertifiedTaskCandidate>[0]) {
  const command = structuredClone(input.command); const plan = parseTaskExecutionPlan(command.args.plan);
  const certified = await executeCertifiedTaskCandidate({ ...input, command });
  if (plan.schema_version === 1 || !certified.checks_passed) return certified;
  const published = await publishTaskGitCandidate({ authority: input.authority, command,
    verification_id: certified.verification_id, clock: input.clock });
  return { ...certified, ...published };
}
