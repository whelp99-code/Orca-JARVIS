import type { MemoryAuthorityResolution } from "./memory-candidate-authority-types.js";
import {
  memoryCandidateConfidence,
  memoryCandidateDisposition,
  memoryCandidateKind,
  memoryStorageSensitivity,
} from "./memory-candidate-classification-rules.js";
import { evaluateMemoryCandidatePolicy, type ParsedMemoryCandidatePolicy } from "./memory-candidate-policy.js";
import {
  MEMORY_CANDIDATE_CONFIRMATION_TTL_MS,
  MEMORY_CANDIDATE_DIGEST_DOMAINS,
  type MemoryCandidateClassification,
  type MemoryCandidateComputation,
  type MemoryCandidateIdentity,
  type MemoryCandidateSourceMetadata,
  type ParsedMemoryCandidateInput,
} from "./memory-candidate-types.js";
import { memoryHash } from "./memory-candidate-values.js";

export type MemoryClassificationContext = {
  readonly now: Date;
  readonly authority: MemoryAuthorityResolution;
};

function policyInputIdentityDigest(input: ParsedMemoryCandidateInput): string {
  return memoryHash(MEMORY_CANDIDATE_DIGEST_DOMAINS.policyInputIdentity, {
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
  });
}

export function memoryCandidateIdentity(input: ParsedMemoryCandidateInput): MemoryCandidateIdentity {
  const contentDigest = memoryHash(MEMORY_CANDIDATE_DIGEST_DOMAINS.content, input.statement);
  const subjectDigest = memoryHash(MEMORY_CANDIDATE_DIGEST_DOMAINS.subject, input.subject);
  const policyInputDigest = policyInputIdentityDigest(input);
  const sourceIdentityDigest = memoryHash(MEMORY_CANDIDATE_DIGEST_DOMAINS.identitySource, {
    policy_input_identity_digest: policyInputDigest,
    input_class: input.source.input_class,
    source_id: input.source.source_id,
    source_version: input.source.source_version,
    request_id: input.source.request_id,
    receipt_id: input.source.receipt_id,
    evidence_id: input.source.evidence_id,
    inference_id: input.source.inference_id,
    references: input.source.references,
  });
  const dedupKey = memoryHash(MEMORY_CANDIDATE_DIGEST_DOMAINS.dedup, {
    source_identity_digest: sourceIdentityDigest,
    subject_digest: subjectDigest,
    content_digest: contentDigest,
    operation: input.operation,
    purpose: input.purpose,
    sensitivity: input.sensitivity,
    principal_id: input.principal_id,
  });
  const identityDigest = memoryHash(MEMORY_CANDIDATE_DIGEST_DOMAINS.identity, { dedup_key: dedupKey });
  return {
    candidate_id: `memcand:pos:v1:${identityDigest.slice(7)}`,
    correlation_id: `corr:memory:${identityDigest.slice(7)}`,
    dedup_key: dedupKey,
    source_identity_digest: sourceIdentityDigest,
    subject_digest: subjectDigest,
    content_digest: contentDigest,
  };
}

function provisionalSource(input: ParsedMemoryCandidateInput): MemoryCandidateSourceMetadata {
  return {
    source_id: input.source.source_id,
    source_version: input.source.source_version,
    principal_id: input.principal_id,
    authenticated_session_digest: null,
    worker_id: null,
    worker_session_digest: null,
    verifier_id: null,
    instruction_id: null,
    outcome_id: null,
    attempt_id: null,
    verification_evidence_id: input.source.evidence_id,
    request_id: input.source.request_id,
    receipt_id: input.source.receipt_id,
    command_digest: null,
    authority_key_id: null,
    authority_expires_at: null,
    inference_id: input.source.inference_id,
    inference_label: input.source.inference_label,
  };
}

export function computeMemoryCandidate(
  policy: ParsedMemoryCandidatePolicy,
  input: ParsedMemoryCandidateInput,
  context: MemoryClassificationContext,
): MemoryCandidateComputation {
  const identity = memoryCandidateIdentity(input);
  const source = context.authority.valid ? context.authority.source : provisionalSource(input);
  const sourceReferences = context.authority.valid ? context.authority.references : input.source.references;
  const references = [...sourceReferences, ...input.conflict.references];
  const sourceRefs = references.map((reference, position) => ({ position, ...reference }));
  const sourceDigest = memoryHash(MEMORY_CANDIDATE_DIGEST_DOMAINS.source, {
    input_class: input.source.input_class,
    source,
    references: sourceRefs,
  });
  const policyOutcome = evaluateMemoryCandidatePolicy(policy, { input, references, now: context.now });
  const disposition = memoryCandidateDisposition({
    input,
    content_digest: identity.content_digest,
    authority_valid: context.authority.valid,
    policy: policyOutcome,
  });
  const confirmationExpiryMs = Math.min(
    context.now.getTime() + MEMORY_CANDIDATE_CONFIRMATION_TTL_MS,
    Date.parse(policyOutcome.candidate_expires_at),
    Date.parse(policyOutcome.source_expires_at),
  );
  const confirmationExpiresAt = disposition.required_confirmation
    ? new Date(confirmationExpiryMs).toISOString() : null;
  const candidateDigest = memoryHash(MEMORY_CANDIDATE_DIGEST_DOMAINS.candidate, {
    candidate_id: identity.candidate_id,
    correlation_id: identity.correlation_id,
    dedup_key: identity.dedup_key,
    subject_digest: identity.subject_digest,
    purpose: input.purpose,
    policy_sensitivity: input.sensitivity,
    retention_days: policyOutcome.retention_days,
    policy_digest: policyOutcome.policy_digest,
  });
  const core: Omit<MemoryCandidateClassification, "classification_digest"> = {
    schema_version: 1,
    candidate_id: identity.candidate_id,
    correlation_id: identity.correlation_id,
    candidate_digest: candidateDigest,
    input_class: input.source.input_class,
    candidate_kind: memoryCandidateKind(input),
    operation: input.operation,
    subject_digest: identity.subject_digest,
    content_digest: identity.content_digest,
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
    dedup_key: identity.dedup_key,
    created_at: context.now.toISOString(),
  };
  const inputDigest = memoryHash(MEMORY_CANDIDATE_DIGEST_DOMAINS.input, {
    policy_digest: policyOutcome.policy_digest,
    input: {
      schema_version: input.schema_version, operation: input.operation, subject: input.subject, statement: input.statement,
      purpose: input.purpose, sensitivity: input.sensitivity, host: input.host, principal_id: input.principal_id,
      payload_fields: input.payload_fields, source: input.source, second_brain: input.second_brain, conflict: input.conflict,
    },
  });
  return {
    classification: { ...core, classification_digest: memoryHash(MEMORY_CANDIDATE_DIGEST_DOMAINS.classification, core) },
    input_digest: inputDigest,
    source_identity_digest: identity.source_identity_digest,
    idempotency_digest: memoryHash(MEMORY_CANDIDATE_DIGEST_DOMAINS.idempotency, input.idempotency_key),
    request_digest: memoryHash(MEMORY_CANDIDATE_DIGEST_DOMAINS.request, {
      idempotency_key: input.idempotency_key,
      input_digest: inputDigest,
    }),
  };
}
