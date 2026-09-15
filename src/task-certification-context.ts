import { createPublicKey } from "node:crypto";
import { JarvisError, type AuthorityDb } from "./db.js";
import type { ClaimedControlCommand } from "./control-plane.js";
import { assertTaskExecutionAuthority } from "./task-execution-authority.js";
import { taskExecutionPlanDigest } from "./task-execution-plan.js";
import { TaskCandidateArtifacts } from "./task-candidate-artifacts.js";
import { candidateInstant, encodeTaskCandidate } from "./task-candidate-artifact-codec.js";
import { remainingTaskExecutionBudget } from "./task-execution-clock.js";
import type { TaskCertificationRequest } from "./task-certification-proof.js";

export const certificationInvalid = (): never => { throw new JarvisError("TASK_CERTIFICATION_BINDING_INVALID"); };
const publicBytes = (pem: string) => {
  const key = createPublicKey(pem);
  if (key.asymmetricKeyType !== "ed25519") return certificationInvalid();
  return key.export({ type: "spki", format: "der" });
};
/** The deployment pins which anchored key names the verifier principal. */
export const TASK_VERIFIER_KEY_ID_ENV = "JARVIS_TASK_VERIFIER_KEY_ID" as const;

type AnchoredVerifierKey = {
  readonly public_key_pem: string;
  readonly principal_id: string;
  readonly algorithm: string;
};

/**
 * A trusted, unrevoked, Ed25519 anchor carrying the `verifier` purpose. Missing, revoked,
 * wrong-purpose and non-Ed25519 all leave by the same door, so nothing about the anchor set is
 * learned from which refusal came back.
 */
function anchoredVerifierKey(authority: AuthorityDb, keyId: string): AnchoredVerifierKey {
  const key = authority.db.prepare(`SELECT k.public_key_pem,k.principal_id,k.algorithm FROM trusted_authority_keys k
    JOIN authority_key_purposes p ON p.key_id=k.key_id WHERE k.key_id=? AND p.purpose='verifier'`)
    .get(keyId) as AnchoredVerifierKey | undefined;
  if (!key || key.algorithm !== "Ed25519"
    || authority.db.prepare("SELECT 1 FROM authority_revocations WHERE reference=?").get(keyId)) {
    return certificationInvalid();
  }
  // Refuses a PEM that is not actually an Ed25519 public key, whatever the column claims.
  publicBytes(key.public_key_pem);
  return key;
}

/**
 * The verifier principal a certification must be signed for. It is read from the anchored key the
 * deployment pinned through JARVIS_TASK_VERIFIER_KEY_ID, never from a name compiled in here: a
 * sealed deployment cannot add a key to match a constant, and its anchored verifier may legitimately
 * be principal `jm-verifier` rather than `independent-verifier`. With no pin configured the anchor
 * is the requested key itself, which still has to satisfy every structural check.
 */
export function taskCertificationVerifierPrincipal(authority: AuthorityDb, requestedKeyId: string): string {
  const configured = process.env[TASK_VERIFIER_KEY_ID_ENV];
  return anchoredVerifierKey(authority, configured ?? requestedKeyId).principal_id;
}

export function taskCertificationVerifierKey(authority: AuthorityDb, keyId: string): string {
  const expected = taskCertificationVerifierPrincipal(authority, keyId);
  const key = anchoredVerifierKey(authority, keyId);
  if (key.principal_id !== expected) return certificationInvalid();
  const bytes = publicBytes(key.public_key_pem);
  const decisions = authority.db.prepare(`SELECT k.public_key_pem FROM trusted_authority_keys k
    JOIN authority_key_purposes p ON p.key_id=k.key_id WHERE p.purpose='decision'`).all() as Array<{ public_key_pem: string }>;
  if (decisions.some(decision => publicBytes(decision.public_key_pem).equals(bytes))) return certificationInvalid();
  return key.public_key_pem;
}

/** Caller holds an IMMEDIATE transaction while reserving, claiming, or recording a certification. */
export function taskCertificationContext(authority: AuthorityDb, command: ClaimedControlCommand, keyId: string,
  verificationId: string, requestedAt: string, clock: () => Date) {
  const now = clock();
  const plan = assertTaskExecutionAuthority(authority, command, now);
  const artifact = new TaskCandidateArtifacts(authority).read(command.request_id);
  if (!artifact || !candidateInstant(requestedAt) || requestedAt < artifact.created_at || Date.parse(requestedAt) > now.getTime()) {
    return certificationInvalid();
  }
  const attempt = authority.db.prepare(`SELECT task_clock_id,task_deadline_uptime_ms FROM control_effect_attempts
    WHERE attempt_id=? AND request_id=? AND receipt_id=? AND lease_fence=? AND task_run_id=? AND task_plan_digest=? AND state='invoking'`)
    .get(artifact.attempt_id, command.request_id, command.receipt_id, command.fence, plan.run_id, taskExecutionPlanDigest(plan)) as {
      task_clock_id: string; task_deadline_uptime_ms: number } | undefined;
  if (!attempt) return certificationInvalid();
  const budget = { clock_id: attempt.task_clock_id, deadline_uptime_ms: attempt.task_deadline_uptime_ms };
  const remaining = remainingTaskExecutionBudget(budget);
  const publicKey = taskCertificationVerifierKey(authority, keyId);
  const priorBytes = artifact.verification?.checks.reduce((n, check) => n + check.stdout_bytes + check.stderr_bytes, 0) ?? 0;
  const outputBytes = plan.limits.max_output_bytes - artifact.provider_output_bytes - priorBytes;
  if (outputBytes < 0 || remaining > plan.limits.timeout_ms || artifact.plan.task_spec_digest !== plan.task_spec_digest) {
    return certificationInvalid();
  }
  const request: TaskCertificationRequest = { schema_version: 1, verification_id: verificationId, attempt_id: artifact.attempt_id,
    request_id: command.request_id, receipt_id: command.receipt_id, fence: command.fence, run_id: plan.run_id, task_id: plan.task_id,
    task_spec_digest: plan.task_spec_digest, execution_plan_digest: taskExecutionPlanDigest(plan), artifact_id: artifact.artifact_id,
    payload_digest: artifact.payload_digest, candidate_digest: artifact.candidate_digest, key_id: keyId, requested_at: requestedAt,
    expires_at: command.lease_expires_at, max_output_bytes: outputBytes, ...budget };
  const encoded = encodeTaskCandidate(artifact.attempt_id, plan, artifact.files, artifact.repository, artifact.provider_output_bytes);
  const finalTime = clock();
  assertTaskExecutionAuthority(authority, command, finalTime);
  return { request, artifact, publicKey, encoded,
    remaining_ms: Math.min(remainingTaskExecutionBudget(budget), Date.parse(request.expires_at) - finalTime.getTime()) };
}
