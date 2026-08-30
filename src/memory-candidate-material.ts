import {
  memoryCandidateConfidence,
  memoryCandidateDisposition,
  memoryCandidateKind,
  memoryStorageSensitivity,
} from "./memory-candidate-classification-rules.js";
import {
  evaluateMemoryCandidatePolicy,
  type ParsedMemoryCandidatePolicy,
} from "./memory-candidate-policy.js";
import {
  MEMORY_CANDIDATE_CONFIRMATION_TTL_MS,
  MEMORY_CANDIDATE_DIGEST_DOMAINS,
  type MemoryCandidateClassification,
  type MemoryCandidateComputation,
  type ParsedMemoryCandidateInput,
} from "./memory-candidate-types.js";
import { memoryHash } from "./memory-candidate-values.js";

export type MemoryClassificationContext = {
  readonly now: Date;
  readonly approved_decision_valid: boolean;
};

export function memoryDecisionBindingDigest(input: ParsedMemoryCandidateInput): string {
  return memoryHash(MEMORY_CANDIDATE_DIGEST_DOMAINS.decision, {
    content_digest: memoryHash(MEMORY_CANDIDATE_DIGEST_DOMAINS.content, input.statement),
    subject_digest: memoryHash(MEMORY_CANDIDATE_DIGEST_DOMAINS.subject, input.subject),
    operation: input.operation,
    purpose: input.purpose,
    sensitivity: input.sensitivity,
  });
}

export function computeMemoryCandidate(
  policy: ParsedMemoryCandidatePolicy,
  input: ParsedMemoryCandidateInput,
  context: MemoryClassificationContext,
): MemoryCandidateComputation {
  const references = [...input.source.references, ...input.conflict.references];
  const sourceRefs = references.map((reference, position) => ({ position, ...reference }));
  const contentDigest = memoryHash(MEMORY_CANDIDATE_DIGEST_DOMAINS.content, input.statement);
  const subjectDigest = memoryHash(MEMORY_CANDIDATE_DIGEST_DOMAINS.subject, input.subject);
  const source = {
    source_id: input.source.source_id,
    source_version: input.source.source_version,
    principal_id: input.source.principal_id ?? input.principal_id,
    authenticated_session_id: input.source.authenticated_session_id,
    worker_id: input.source.worker_id,
    verifier_id: input.source.verifier_id,
    request_id: input.source.request_id,
    receipt_id: input.source.receipt_id,
    command_digest: input.source.command_digest,
    inference_label: input.source.inference_label,
  };
  const sourceDigest = memoryHash(MEMORY_CANDIDATE_DIGEST_DOMAINS.source, {
    input_class: input.source.input_class,
    source,
    references: sourceRefs,
  });
  const policyOutcome = evaluateMemoryCandidatePolicy(policy, { input, references, now: context.now });
  const disposition = memoryCandidateDisposition({
    input,
    content_digest: contentDigest,
    approved_decision_valid: context.approved_decision_valid,
    policy: policyOutcome,
  });
  const confirmationExpiryMs = Math.min(
    context.now.getTime() + MEMORY_CANDIDATE_CONFIRMATION_TTL_MS,
    Date.parse(policyOutcome.candidate_expires_at),
    Date.parse(policyOutcome.source_expires_at),
  );
  const confirmationExpiresAt = disposition.required_confirmation
    ? new Date(confirmationExpiryMs).toISOString() : null;
  const dedupKey = memoryHash(MEMORY_CANDIDATE_DIGEST_DOMAINS.dedup, {
    source_digest: sourceDigest,
    content_digest: contentDigest,
    operation: input.operation,
  });
  const candidateId = `memcand:pos:v1:${dedupKey.slice(7)}`;
  const candidateDigest = memoryHash(MEMORY_CANDIDATE_DIGEST_DOMAINS.candidate, {
    candidate_id: candidateId,
    dedup_key: dedupKey,
    subject_digest: subjectDigest,
    purpose: input.purpose,
    policy_sensitivity: input.sensitivity,
    retention_days: policyOutcome.retention_days,
    policy_digest: policyOutcome.policy_digest,
  });
  const core: Omit<MemoryCandidateClassification, "classification_digest"> = {
    schema_version: 1,
    candidate_id: candidateId,
    candidate_digest: candidateDigest,
    input_class: input.source.input_class,
    candidate_kind: memoryCandidateKind(input),
    operation: input.operation,
    subject_digest: subjectDigest,
    content_digest: contentDigest,
    source_digest: sourceDigest,
    source_refs: sourceRefs,
    source,
    confidence: memoryCandidateConfidence(input),
    policy_sensitivity: input.sensitivity,
    storage_sensitivity: memoryStorageSensitivity(input),
    purpose: input.purpose,
    retention_days: policyOutcome.retention_days,
    required_confirmation: disposition.required_confirmation,
    confirmation_gate: disposition.confirmation_gate,
    candidate_expires_at: policyOutcome.candidate_expires_at,
    confirmation_expires_at: confirmationExpiresAt,
    policy_digest: policyOutcome.policy_digest,
    conflict_state: input.conflict.state,
    state: disposition.state,
    classification_reason: disposition.classification_reason,
    delivery: disposition.delivery,
    dedup_key: dedupKey,
    created_at: context.now.toISOString(),
  };
  const inputDigest = memoryHash(MEMORY_CANDIDATE_DIGEST_DOMAINS.input, {
    policy_digest: policyOutcome.policy_digest,
    input: {
      schema_version: input.schema_version,
      operation: input.operation,
      subject: input.subject,
      statement: input.statement,
      purpose: input.purpose,
      sensitivity: input.sensitivity,
      host: input.host,
      principal_id: input.principal_id,
      payload_fields: input.payload_fields,
      source: input.source,
      second_brain: input.second_brain,
      conflict: input.conflict,
    },
  });
  return {
    classification: {
      ...core,
      classification_digest: memoryHash(MEMORY_CANDIDATE_DIGEST_DOMAINS.classification, core),
    },
    input_digest: inputDigest,
    idempotency_digest: memoryHash(MEMORY_CANDIDATE_DIGEST_DOMAINS.idempotency, input.idempotency_key),
    request_digest: memoryHash(MEMORY_CANDIDATE_DIGEST_DOMAINS.request, {
      idempotency_key: input.idempotency_key,
      input_digest: inputDigest,
    }),
  };
}
