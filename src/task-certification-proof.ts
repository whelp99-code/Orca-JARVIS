import { sign, verify, createPublicKey, type KeyObject } from "node:crypto";
import { canonicalize } from "./canonical.js";
import { JarvisError } from "./db.js";
import { candidateInstant, validateCandidateMeasurement, type encodeTaskCandidate } from "./task-candidate-artifact-codec.js";
import type { TaskCandidateVerification } from "./task-candidate-verification.js";
import type { TaskExecutionClockBudget } from "./task-execution-clock.js";

export const TASK_CERTIFICATION_DOMAIN = "orca-jarvis/task-candidate-verification/v1\0";
export interface TaskCertificationRequest extends TaskExecutionClockBudget {
  readonly schema_version: 1; readonly verification_id: string; readonly attempt_id: string;
  readonly request_id: string; readonly receipt_id: string; readonly fence: number;
  readonly run_id: string; readonly task_id: string; readonly task_spec_digest: string;
  readonly execution_plan_digest: string; readonly artifact_id: string; readonly payload_digest: string;
  readonly candidate_digest: string; readonly key_id: string; readonly requested_at: string;
  readonly expires_at: string; readonly max_output_bytes: number;
}
export interface TaskCertificationProof {
  readonly schema_version: 1; readonly request: TaskCertificationRequest; readonly invocation_id: string;
  readonly measurement: TaskCandidateVerification; readonly principal_id: "independent-verifier";
  readonly algorithm: "Ed25519"; readonly issued_at: string; readonly signature: string;
}
const invalid = (): never => { throw new JarvisError("TASK_CERTIFICATION_PROOF_INVALID"); };
export function signTaskCertification(payload: Omit<TaskCertificationProof, "signature">, key: KeyObject): TaskCertificationProof {
  if (key.type !== "private" || key.asymmetricKeyType !== "ed25519") return invalid();
  return { ...payload, signature: sign(null, Buffer.from(TASK_CERTIFICATION_DOMAIN + canonicalize(payload)), key).toString("base64url") };
}

export function verifyTaskCertification(value: unknown, request: TaskCertificationRequest, invocationId: string,
  candidate: ReturnType<typeof encodeTaskCandidate>, publicKey: string, startedAt: string, now: Date): TaskCertificationProof {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join(",")
      !== "algorithm,invocation_id,issued_at,measurement,principal_id,request,schema_version,signature") return invalid();
    const proof = value as TaskCertificationProof;
    if (!Number.isFinite(now.getTime()) || !candidateInstant(startedAt) || !candidateInstant(request.expires_at)
      || Buffer.byteLength(canonicalize(proof)) > 524288 || proof.schema_version !== 1 || proof.algorithm !== "Ed25519"
      || proof.principal_id !== "independent-verifier" || proof.invocation_id !== invocationId
      || canonicalize(proof.request) !== canonicalize(request) || !candidateInstant(proof.issued_at)
      || proof.issued_at < startedAt || Date.parse(proof.issued_at) > now.getTime()
      || now.getTime() >= Date.parse(request.expires_at)) return invalid();
    const measurement = validateCandidateMeasurement(candidate, proof.measurement);
    if (measurement.checks.reduce((n, check) => n + check.stdout_bytes + check.stderr_bytes, 0) > request.max_output_bytes) return invalid();
    const key = createPublicKey(publicKey);
    const signature = Buffer.from(proof.signature, "base64url");
    const { signature: omitted, ...payload } = proof; void omitted;
    if (key.asymmetricKeyType !== "ed25519" || signature.length !== 64 || signature.toString("base64url") !== proof.signature
      || !verify(null, Buffer.from(TASK_CERTIFICATION_DOMAIN + canonicalize(payload)), key, signature)) return invalid();
    return JSON.parse(canonicalize(proof)) as TaskCertificationProof;
  } catch { return invalid(); }
}
