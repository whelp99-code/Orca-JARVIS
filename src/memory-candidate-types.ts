export const MEMORY_CANDIDATE_INPUT_CLASSES = [
  "explicit_user_instruction", "verified_outcome", "approved_decision", "labeled_inference", "raw_transcript",
  "worker_assertion", "unverified_summary", "transient_runtime", "unlabeled_trait_inference", "model_assertion",
] as const;
export const MEMORY_CANDIDATE_OPERATIONS = ["remember", "correct"] as const;
export const MEMORY_CANDIDATE_POLICY_SENSITIVITIES = ["public", "personal", "sensitive", "restricted"] as const;
export const MEMORY_CANDIDATE_STORAGE_SENSITIVITIES = ["normal", "sensitive", "restricted"] as const;
export const MEMORY_CANDIDATE_STATES = ["classified", "awaiting_confirmation", "approved", "queued",
  "delivering", "accepted_unsettled", "settled", "uncertain", "rejected", "expired"] as const;
export const MEMORY_CANDIDATE_CONFLICT_STATES = ["none", "same", "conflict", "supersede"] as const;
export const MEMORY_CANDIDATE_REF_KINDS = [
  "verification", "artifact", "owner_instruction", "owner_session", "inference_evidence",
  "existing_memory", "second_brain_conflict", "transcript", "unverified",
] as const;
export const MEMORY_CANDIDATE_REF_NAMESPACES = [
  "control_command", "control_receipt", "verification_authority", "verification_artifact",
  "inference_evidence", "memory_candidate", "second_brain_conflict", "rejected_input",
] as const;
export const MEMORY_CANDIDATE_CONFIRMATION_GATE = "PERSONAL_MEMORY_CONFIRMATION" as const;
export const MEMORY_CANDIDATE_CONFIRMATION_TTL_MS = 24 * 60 * 60_000;
export const MEMORY_CANDIDATE_DIGEST_DOMAINS = {
  content: "orca-jarvis/memory-content/v1\0",
  subject: "orca-jarvis/memory-subject/v1\0",
  identity: "orca-jarvis/memory-identity/v1\0",
  identitySource: "orca-jarvis/memory-identity-source/v1\0",
  verification: "orca-jarvis/memory-verification/v1\0",
  verificationAuthority: "orca-jarvis/memory-verification-authority/v1\0",
  authorityRecord: "orca-jarvis/memory-authority-record/v1\0",
  session: "orca-jarvis/memory-session/v1\0",
  source: "orca-jarvis/memory-source/v1\0",
  policy: "orca-jarvis/memory-policy/v1\0",
  policyInputIdentity: "orca-jarvis/memory-policy-input-identity/v1\0",
  input: "orca-jarvis/memory-input/v1\0",
  idempotency: "orca-jarvis/memory-idempotency/v1\0",
  request: "orca-jarvis/memory-request/v1\0",
  dedup: "orca-jarvis/memory-dedup/v1\0",
  candidate: "orca-jarvis/memory-candidate/v1\0",
  classification: "orca-jarvis/memory-classification/v1\0",
  audit: "orca-jarvis/memory-audit/v1\0",
} as const;
export const MEMORY_CANDIDATE_REASON_CODES = [
  "VERIFIED_OUTCOME_APPROVED", "EXPLICIT_OWNER_INSTRUCTION_APPROVED", "APPROVED_DECISION_APPROVED",
  "LABELED_INFERENCE_CONFIRMATION_REQUIRED", "SENSITIVE_MEMORY_CONFIRMATION_REQUIRED",
  "CORRECTION_CONFIRMATION_REQUIRED", "SUPERSEDE_CONFIRMATION_REQUIRED", "SECOND_BRAIN_NO_DATA",
  "RAW_TRANSCRIPT_REJECTED", "WORKER_ASSERTION_REJECTED", "UNVERIFIED_SUMMARY_REJECTED",
  "TRANSIENT_RUNTIME_REJECTED", "UNLABELED_TRAIT_INFERENCE_REJECTED", "MODEL_AUTHORITY_REJECTED",
  "PROHIBITED_CONTENT", "PROMPT_TEXT_REJECTED", "PROHIBITED_POLICY_FIELD", "OWNER_PROVENANCE_INVALID",
  "UNVERIFIED_OUTCOME", "APPROVAL_RECEIPT_INVALID", "INFERENCE_PROVENANCE_INVALID", "PRINCIPAL_MISMATCH",
  "PURPOSE_MISMATCH", "HOST_OWNER_MISMATCH", "POLICY_NOT_EFFECTIVE", "POLICY_EXPIRED", "SOURCE_TIME_INVALID",
  "SOURCE_STALE", "SOURCE_EXPIRED", "RETENTION_EXPIRED", "SECOND_BRAIN_STATE_STALE", "OPEN_CONFLICT",
  "CONFLICT_DECLARATION_INVALID", "POLICY_DENIED",
] as const;
export const MEMORY_CANDIDATE_ERROR_CODES = [
  "MEMORY_CANDIDATE_INPUT_INVALID", "MEMORY_CANDIDATE_POLICY_INVALID", "MEMORY_CANDIDATE_AUTHORITY_INVALID",
  "MEMORY_CANDIDATE_REPLAY_CONFLICT", "MEMORY_CANDIDATE_INTEGRITY_FAILURE",
  "MEMORY_CANDIDATE_SUPPRESSED",
] as const;

export type MemoryCandidateInputClass = (typeof MEMORY_CANDIDATE_INPUT_CLASSES)[number];
export type MemoryCandidateOperation = (typeof MEMORY_CANDIDATE_OPERATIONS)[number];
export type MemoryCandidatePolicySensitivity = (typeof MEMORY_CANDIDATE_POLICY_SENSITIVITIES)[number];
export type MemoryCandidateStorageSensitivity = (typeof MEMORY_CANDIDATE_STORAGE_SENSITIVITIES)[number];
export type MemoryCandidateState = (typeof MEMORY_CANDIDATE_STATES)[number];
export type MemoryCandidateConflictState = (typeof MEMORY_CANDIDATE_CONFLICT_STATES)[number];
export type MemoryCandidateRefKind = (typeof MEMORY_CANDIDATE_REF_KINDS)[number];
export type MemoryCandidateRefNamespace = (typeof MEMORY_CANDIDATE_REF_NAMESPACES)[number];
export type MemoryCandidateReasonCode = (typeof MEMORY_CANDIDATE_REASON_CODES)[number];
export type MemoryCandidateErrorCode = (typeof MEMORY_CANDIDATE_ERROR_CODES)[number];
export type MemoryCandidateConfidence = "verified" | "confirmed" | "inferred";
export type MemoryCandidateKind = "verified_fact" | "user_instruction" | "inference" | "correction";

export class MemoryCandidateError extends Error {
  readonly name = "MemoryCandidateError";
  constructor(readonly code: MemoryCandidateErrorCode) { super(code); }
}

export type MemoryReferenceIdentifier = {
  readonly namespace: MemoryCandidateRefNamespace;
  readonly id: string;
  readonly version: 1;
};
export type MemorySourceReference = {
  readonly position: number;
  readonly kind: MemoryCandidateRefKind;
  readonly identifier: MemoryReferenceIdentifier;
  readonly evidence_digest: string;
  readonly observed_at: string;
  readonly fresh_until: string;
  readonly expires_at: string;
};
export type MemoryCandidateSourceMetadata = {
  readonly source_id: string;
  readonly source_version: string;
  readonly principal_id: string | null;
  readonly authenticated_session_digest: string | null;
  readonly worker_id: string | null;
  readonly worker_session_digest: string | null;
  readonly verifier_id: string | null;
  readonly instruction_id: string | null;
  readonly outcome_id: string | null;
  readonly attempt_id: string | null;
  readonly verification_evidence_id: string | null;
  readonly request_id: string | null;
  readonly receipt_id: string | null;
  readonly command_digest: string | null;
  readonly authority_key_id: string | null;
  readonly authority_expires_at: string | null;
  readonly inference_id: string | null;
  readonly inference_label: "inference" | null;
};
export type MemoryCandidateDelivery = { readonly state: "not_created" | "pending" | "blocked"; readonly reason: MemoryCandidateReasonCode | null };
export type MemoryCandidateClassification = {
  readonly schema_version: 1; readonly candidate_id: string; readonly correlation_id: string;
  readonly candidate_digest: string; readonly input_class: MemoryCandidateInputClass; readonly candidate_kind: MemoryCandidateKind;
  readonly operation: MemoryCandidateOperation; readonly subject_digest: string; readonly content_digest: string;
  readonly source_digest: string; readonly source_refs: readonly MemorySourceReference[]; readonly source: MemoryCandidateSourceMetadata;
  readonly confidence: MemoryCandidateConfidence; readonly policy_sensitivity: MemoryCandidatePolicySensitivity;
  readonly storage_sensitivity: MemoryCandidateStorageSensitivity; readonly purpose: string; readonly retention_days: number;
  readonly required_confirmation: boolean; readonly confirmation_gate: typeof MEMORY_CANDIDATE_CONFIRMATION_GATE | null;
  readonly candidate_expires_at: string; readonly confirmation_expires_at: string | null; readonly policy_digest: string;
  readonly conflict_state: MemoryCandidateConflictState; readonly state: MemoryCandidateState;
  readonly classification_reason: MemoryCandidateReasonCode; readonly delivery: MemoryCandidateDelivery;
  readonly dedup_key: string; readonly classification_digest: string; readonly created_at: string;
};

export type ParsedMemoryReference = Omit<MemorySourceReference, "position">;
export type ParsedMemorySource = {
  readonly input_class: MemoryCandidateInputClass; readonly source_id: string; readonly source_version: string;
  readonly request_id: string | null; readonly receipt_id: string | null; readonly evidence_id: string | null;
  readonly inference_id: string | null; readonly inference_label: "inference" | null;
  readonly references: readonly ParsedMemoryReference[];
};
export type ParsedSecondBrainState = { readonly state: "available" }
  | { readonly state: "no_data"; readonly checked_at: string; readonly fresh_until: string };
export type ParsedMemoryConflict = { readonly state: MemoryCandidateConflictState; readonly references: readonly ParsedMemoryReference[] };
export type ParsedMemoryCandidateInput = {
  readonly schema_version: 1 | 2; readonly body_profile?: "plain-text-v1"; readonly idempotency_key: string; readonly operation: MemoryCandidateOperation;
  readonly subject: string; readonly statement: string; readonly purpose: string;
  readonly sensitivity: MemoryCandidatePolicySensitivity; readonly host: "linux-control-plane" | "linux-second-brain";
  readonly principal_id: string; readonly payload_fields: readonly string[]; readonly source: ParsedMemorySource;
  readonly second_brain: ParsedSecondBrainState; readonly conflict: ParsedMemoryConflict;
};
export type MemoryCandidateComputation = {
  readonly classification: MemoryCandidateClassification; readonly input_digest: string;
  readonly source_identity_digest: string; readonly idempotency_digest: string; readonly request_digest: string;
};
export type MemoryCandidateIdentity = {
  readonly candidate_id: string; readonly correlation_id: string; readonly dedup_key: string;
  readonly source_identity_digest: string; readonly subject_digest: string; readonly content_digest: string;
};
