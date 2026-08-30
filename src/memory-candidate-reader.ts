import type Database from "better-sqlite3";
import { memoryOpaqueId, memoryOpaqueReferenceId } from "./memory-candidate-source.js";
import {
  MEMORY_CANDIDATE_DIGEST_DOMAINS,
  MEMORY_CANDIDATE_INPUT_CLASSES,
  MEMORY_CANDIDATE_OPERATIONS,
  MEMORY_CANDIDATE_POLICY_SENSITIVITIES,
  MEMORY_CANDIDATE_REASON_CODES,
  MEMORY_CANDIDATE_REF_KINDS,
  MEMORY_CANDIDATE_REF_NAMESPACES,
  MEMORY_CANDIDATE_STATES,
  MEMORY_CANDIDATE_STORAGE_SENSITIVITIES,
  type MemoryCandidateClassification,
  type MemoryCandidateDelivery,
  type MemoryCandidateReasonCode,
} from "./memory-candidate-types.js";
import { memoryDigest, memoryFail, memoryHash, memoryInstant, memoryMember, memoryText } from "./memory-candidate-values.js";
import { persistenceNumber, persistenceRow, persistenceText } from "./personal-persistence-values.js";

const CANDIDATE_KINDS = ["verified_fact", "user_instruction", "inference", "correction"] as const;
const CONFLICT_STATES = ["none", "same", "conflict", "supersede"] as const;
const CONFIDENCE = ["verified", "confirmed", "inferred"] as const;
const DELIVERY_STATES = ["not_created", "pending", "blocked"] as const;

function nullableText(value: unknown): string | null { return value === null ? null : persistenceText(value); }
function nullableDigest(value: unknown): string | null { return value === null ? null : memoryDigest(value); }
function nullableInstant(value: unknown): string | null { return value === null ? null : memoryInstant(value); }

function delivery(row: Readonly<Record<string, unknown>>): MemoryCandidateDelivery {
  const state = memoryMember(row["delivery_state"], DELIVERY_STATES);
  const reasonValue = nullableText(row["delivery_reason"]);
  const reason: MemoryCandidateReasonCode | null = reasonValue === null ? null : memoryMember(reasonValue, MEMORY_CANDIDATE_REASON_CODES);
  if ((state === "not_created") !== (reason === null) || (state === "pending" && reason !== "SECOND_BRAIN_NO_DATA")) {
    return memoryFail("MEMORY_CANDIDATE_INTEGRITY_FAILURE");
  }
  return { state, reason };
}

export function readMemoryCandidate(
  database: Database.Database,
  candidateId: string,
): MemoryCandidateClassification | undefined {
  const value = database.prepare(
    `SELECT c.*,m.schema_version,m.input_digest,m.identity_source_digest,m.candidate_digest,m.input_class,m.confidence,
      m.policy_sensitivity,m.retention_days,m.confirmation_gate,m.policy_digest,m.classification_reason,
      m.classification_digest,m.dedup_key,m.source_id,m.source_version,m.owner_principal,
      m.authenticated_session_digest,m.worker_id,m.worker_session_digest,m.verifier_id,m.instruction_id,m.outcome_id,
      m.attempt_id,m.verification_evidence_id,m.control_request_id,m.control_receipt_id,m.control_command_digest,
      m.authority_key_id,m.authority_expires_at,m.inference_id,m.inference_label,m.conflict_state,m.delivery_state,m.delivery_reason
     FROM memory_candidates c JOIN memory_candidate_classifications m ON m.candidate_id=c.candidate_id
     WHERE c.candidate_id=?`,
  ).get(candidateId);
  if (value === undefined) return undefined;
  const row = persistenceRow(value);
  const refValues: readonly unknown[] = database.prepare(
    `SELECT position,ref_kind,ref_namespace,ref_id,ref_version,evidence_digest,observed_at,fresh_until,expires_at
     FROM memory_candidate_source_refs WHERE candidate_id=? ORDER BY position`,
  ).all(candidateId);
  const sourceRefs = refValues.map((item, index) => {
    const reference = persistenceRow(item);
    const position = persistenceNumber(reference["position"]);
    if (position !== index || reference["ref_version"] !== 1) return memoryFail("MEMORY_CANDIDATE_INTEGRITY_FAILURE");
    return {
      position,
      kind: memoryMember(reference["ref_kind"], MEMORY_CANDIDATE_REF_KINDS),
      identifier: {
        namespace: memoryMember(reference["ref_namespace"], MEMORY_CANDIDATE_REF_NAMESPACES),
        id: memoryOpaqueReferenceId(reference["ref_id"]),
        version: 1 as const,
      },
      evidence_digest: memoryDigest(reference["evidence_digest"]),
      observed_at: memoryInstant(reference["observed_at"]),
      fresh_until: memoryInstant(reference["fresh_until"]),
      expires_at: memoryInstant(reference["expires_at"]),
    };
  });
  const source = {
    source_id: memoryOpaqueId(row["source_id"]),
    source_version: memoryOpaqueId(row["source_version"]),
    principal_id: nullableText(row["owner_principal"]),
    authenticated_session_digest: nullableDigest(row["authenticated_session_digest"]),
    worker_id: nullableText(row["worker_id"]),
    worker_session_digest: nullableDigest(row["worker_session_digest"]),
    verifier_id: nullableText(row["verifier_id"]),
    instruction_id: nullableText(row["instruction_id"]),
    outcome_id: nullableText(row["outcome_id"]),
    attempt_id: nullableText(row["attempt_id"]),
    verification_evidence_id: nullableText(row["verification_evidence_id"]),
    request_id: nullableText(row["control_request_id"]),
    receipt_id: nullableText(row["control_receipt_id"]),
    command_digest: nullableDigest(row["control_command_digest"]),
    authority_key_id: nullableText(row["authority_key_id"]),
    authority_expires_at: nullableInstant(row["authority_expires_at"]),
    inference_id: nullableText(row["inference_id"]),
    inference_label: row["inference_label"] === null ? null : memoryMember(row["inference_label"], ["inference"] as const),
  };
  const requiredValue = persistenceNumber(row["required_confirmation"]);
  if (requiredValue !== 0 && requiredValue !== 1) return memoryFail("MEMORY_CANDIDATE_INTEGRITY_FAILURE");
  const requiredConfirmation = requiredValue === 1;
  const confirmationGate = row["confirmation_gate"] === null
    ? null : memoryMember(row["confirmation_gate"], ["PERSONAL_MEMORY_CONFIRMATION"] as const);
  if (requiredConfirmation !== (confirmationGate === "PERSONAL_MEMORY_CONFIRMATION")) {
    return memoryFail("MEMORY_CANDIDATE_INTEGRITY_FAILURE");
  }
  const core: Omit<MemoryCandidateClassification, "classification_digest"> = {
    schema_version: 1,
    candidate_id: memoryText(row["candidate_id"], 256),
    correlation_id: memoryText(row["correlation_id"], 256),
    candidate_digest: memoryDigest(row["candidate_digest"]),
    input_class: memoryMember(row["input_class"], MEMORY_CANDIDATE_INPUT_CLASSES),
    candidate_kind: memoryMember(row["candidate_kind"], CANDIDATE_KINDS),
    operation: memoryMember(row["operation"], MEMORY_CANDIDATE_OPERATIONS),
    subject_digest: memoryDigest(row["subject_digest"]),
    content_digest: memoryDigest(row["content_digest"]),
    source_digest: memoryDigest(row["source_digest"]),
    source_refs: sourceRefs,
    source,
    confidence: memoryMember(row["confidence"], CONFIDENCE),
    policy_sensitivity: memoryMember(row["policy_sensitivity"], MEMORY_CANDIDATE_POLICY_SENSITIVITIES),
    storage_sensitivity: memoryMember(row["sensitivity"], MEMORY_CANDIDATE_STORAGE_SENSITIVITIES),
    purpose: memoryText(row["purpose"], 128),
    retention_days: persistenceNumber(row["retention_days"]),
    required_confirmation: requiredConfirmation,
    confirmation_gate: confirmationGate,
    candidate_expires_at: memoryInstant(row["expires_at"]),
    confirmation_expires_at: nullableInstant(row["confirmation_expires_at"]),
    policy_digest: memoryDigest(row["policy_digest"]),
    conflict_state: memoryMember(row["conflict_state"], CONFLICT_STATES),
    state: memoryMember(row["state"], MEMORY_CANDIDATE_STATES),
    classification_reason: memoryMember(row["classification_reason"], MEMORY_CANDIDATE_REASON_CODES),
    delivery: delivery(row),
    dedup_key: memoryDigest(row["dedup_key"]),
    created_at: memoryInstant(row["created_at"]),
  };
  const sourceIdentityDigest = memoryDigest(row["identity_source_digest"]);
  const expectedSource = memoryHash(MEMORY_CANDIDATE_DIGEST_DOMAINS.source, {
    input_class: core.input_class, source: core.source, references: core.source_refs,
  });
  const expectedDedup = memoryHash(MEMORY_CANDIDATE_DIGEST_DOMAINS.dedup, {
    source_identity_digest: sourceIdentityDigest,
    subject_digest: core.subject_digest,
    content_digest: core.content_digest,
    operation: core.operation,
    purpose: core.purpose,
    sensitivity: core.policy_sensitivity,
    principal_id: core.source.principal_id,
  });
  const identityDigest = memoryHash(MEMORY_CANDIDATE_DIGEST_DOMAINS.identity, { dedup_key: expectedDedup });
  const expectedCandidate = memoryHash(MEMORY_CANDIDATE_DIGEST_DOMAINS.candidate, {
    candidate_id: core.candidate_id, correlation_id: core.correlation_id, dedup_key: core.dedup_key,
    subject_digest: core.subject_digest, purpose: core.purpose, policy_sensitivity: core.policy_sensitivity,
    retention_days: core.retention_days, policy_digest: core.policy_digest,
  });
  const classificationDigest = memoryDigest(row["classification_digest"]);
  if (row["schema_version"] !== 1 || core.source_digest !== expectedSource || core.dedup_key !== expectedDedup
    || core.candidate_id !== `memcand:pos:v1:${identityDigest.slice(7)}`
    || core.correlation_id !== `corr:memory:${identityDigest.slice(7)}` || core.candidate_digest !== expectedCandidate
    || classificationDigest !== memoryHash(MEMORY_CANDIDATE_DIGEST_DOMAINS.classification, core)) {
    return memoryFail("MEMORY_CANDIDATE_INTEGRITY_FAILURE");
  }
  return { ...core, classification_digest: classificationDigest };
}
