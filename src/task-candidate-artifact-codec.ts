import { createHash } from "node:crypto";
import { canonicalize } from "./canonical.js";
import { JarvisError } from "./db.js";
import { freezeTaskCandidate, type TaskCandidateVerification } from "./task-candidate-verification.js";
import type { TaskExecutionPlanV1 } from "./task-execution-plan.js";
import type { TaskRepositoryCheck } from "./task-execution-workspace.js";
import type { TaskSandboxFile } from "./task-sandbox.js";

export const CANDIDATE_PAYLOAD_LIMIT = 24 * 1024 * 1024;
export const CANDIDATE_MEASUREMENT_LIMIT = 256 * 1024;
export const candidateHash = (value: string | Buffer) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
export const artifactInvalid = (): never => { throw new JarvisError("TASK_CANDIDATE_ARTIFACT_INVALID"); };
const keys = (value: unknown, names: string): value is Record<string, any> => value !== null && typeof value === "object"
  && !Array.isArray(value) && Object.keys(value).sort().join(",") === names;
export const candidateInstant = (value: unknown): value is string => typeof value === "string"
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;

function repositoryCheck(value: unknown, candidate: ReturnType<typeof freezeTaskCandidate>): TaskRepositoryCheck {
  if (!keys(value, "baseline_commit,execution_plan_digest,files,snapshot_digest,state,total_bytes")
    || value.state !== "checked" || value.execution_plan_digest !== candidate.execution_plan_digest
    || value.baseline_commit !== candidate.plan.repository.baseline_commit || !Array.isArray(value.files)
    || value.files.length !== candidate.plan.files.length) return artifactInvalid();
  let total = 0;
  for (const [index, file] of value.files.entries()) {
    const expected = candidate.plan.files[index]!;
    if (!keys(file, "access,bytes,digest,executable,path") || file.path !== expected.path || file.access !== expected.access
      || file.digest !== expected.before_digest || typeof file.executable !== "boolean"
      || !Number.isSafeInteger(file.bytes) || file.bytes < 0 || file.bytes > 4 * 1024 * 1024
      || (file.digest === null && (file.bytes !== 0 || file.executable))
      || (file.access === "read" && file.bytes !== candidate.frozen[index]!.content.length)) return artifactInvalid();
    total += file.bytes;
  }
  const manifest = { state: value.state, execution_plan_digest: value.execution_plan_digest, baseline_commit: value.baseline_commit,
    total_bytes: value.total_bytes, files: value.files };
  if (total > 16 * 1024 * 1024 || total !== value.total_bytes || value.snapshot_digest !== candidateHash(canonicalize(manifest))) {
    return artifactInvalid();
  }
  return value as unknown as TaskRepositoryCheck;
}

export function encodeTaskCandidate(attemptId: string, plan: TaskExecutionPlanV1, files: readonly TaskSandboxFile[],
  repository: TaskRepositoryCheck, providerBytes: number) {
  const candidate = freezeTaskCandidate(plan, files);
  const checked = repositoryCheck(repository, candidate);
  if (!Number.isSafeInteger(providerBytes) || providerBytes < 0 || providerBytes > plan.limits.max_output_bytes) return artifactInvalid();
  const payload = Buffer.from(canonicalize({ schema_version: 1, attempt_id: attemptId,
    execution_plan_digest: candidate.execution_plan_digest, repository: checked, provider_output_bytes: providerBytes,
    files: candidate.frozen.map(file => ({ path: file.path, base64: file.content.toString("base64") })) }));
  if (payload.length > CANDIDATE_PAYLOAD_LIMIT) return artifactInvalid();
  return { payload, payload_digest: candidateHash(payload), candidate, repository: checked, provider_output_bytes: providerBytes };
}

export function decodeTaskCandidate(attemptId: string, plan: TaskExecutionPlanV1, payload: Buffer) {
  if (!Buffer.isBuffer(payload) || payload.length > CANDIDATE_PAYLOAD_LIMIT) return artifactInvalid();
  const value: unknown = JSON.parse(payload.toString("utf8"));
  if (!keys(value, "attempt_id,execution_plan_digest,files,provider_output_bytes,repository,schema_version")
    || value.schema_version !== 1 || value.attempt_id !== attemptId || !Array.isArray(value.files)
    || value.files.length !== plan.files.length) return artifactInvalid();
  const files = value.files.map((file: unknown) => {
    if (!keys(file, "base64,path") || typeof file.path !== "string" || typeof file.base64 !== "string"
      || file.base64.length > 4 * Math.ceil(4 * 1024 * 1024 / 3)) return artifactInvalid();
    const content = Buffer.from(file.base64, "base64");
    if (content.toString("base64") !== file.base64) return artifactInvalid();
    return { path: file.path, content };
  });
  const encoded = encodeTaskCandidate(attemptId, plan, files, value.repository, value.provider_output_bytes);
  if (value.execution_plan_digest !== encoded.candidate.execution_plan_digest || !encoded.payload.equals(payload)) return artifactInvalid();
  return encoded;
}

/** Structural consistency of a local measurement; this never grants verifier identity or completion authority. */
export function validateCandidateMeasurement(candidate: ReturnType<typeof decodeTaskCandidate>, value: unknown): TaskCandidateVerification {
  const frozen = candidate.candidate;
  if (!keys(value, "candidate_digest,checks,execution_plan_digest,files,state")
    || value.execution_plan_digest !== frozen.execution_plan_digest || value.candidate_digest !== frozen.candidate_digest
    || canonicalize(value.files) !== canonicalize(frozen.files) || !Array.isArray(value.checks)
    || value.checks.length < 1 || value.checks.length > frozen.plan.verification.length) return artifactInvalid();
  let bytes = candidate.provider_output_bytes;
  for (const [index, check] of value.checks.entries()) {
    if (!keys(check, "exit_code,id,stderr_bytes,stderr_digest,stdout_bytes,stdout_digest")
      || check.id !== frozen.plan.verification[index]!.id || !Number.isSafeInteger(check.exit_code)
      || check.exit_code < -1 || check.exit_code > 255
      || ![check.stdout_bytes, check.stderr_bytes].every(n => Number.isSafeInteger(n) && n >= 0)
      || ![check.stdout_digest, check.stderr_digest].every(d => typeof d === "string" && /^sha256:[a-f0-9]{64}$/.test(d))
      || (index < value.checks.length - 1 && check.exit_code !== 0)) return artifactInvalid();
    bytes += check.stdout_bytes + check.stderr_bytes;
  }
  const passed = value.checks.at(-1).exit_code === 0;
  if (bytes > frozen.plan.limits.max_output_bytes || (passed ? value.state !== "checks_passed"
    || value.checks.length !== frozen.plan.verification.length : value.state !== "checks_failed")) return artifactInvalid();
  return JSON.parse(canonicalize(value)) as TaskCandidateVerification;
}
