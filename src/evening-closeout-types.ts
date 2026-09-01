import type {
  PriorityCustomerImpact,
  PriorityDeadlineBucket,
  PriorityDependencyBlocking,
  PriorityEffortCost,
  PriorityIrreversibleRisk,
  PriorityOwnerSafetyGate,
} from "./priority-engine-contracts.js";

export type CloseoutCitation = {
  readonly citation_id: string;
  readonly source_id: string;
  readonly evidence_id: string;
};
export type CloseoutReadiness = "ready" | "degraded" | "no_data";
export type CloseoutVerification = {
  readonly schema_version: 1;
  readonly evidence_id: string;
  readonly verifier_id: string;
  readonly verdict: "passed" | "failed" | "uncertain";
  readonly machine_outcome: "succeeded" | "failed" | "unknown";
  readonly artifact_id: string;
  readonly artifact_digest: string;
  readonly completion_evidence_id: string;
  readonly completion_evidence_digest: string;
  readonly observed_at: string;
  readonly verified_at: string;
  readonly key_id: string;
  readonly public_key_spki: string;
  readonly public_key_fingerprint: string;
  readonly canonical_digest: string;
  readonly signature: string;
};
export type CloseoutRecord = {
  readonly item_id: string;
  readonly outcome: "completed" | "open" | "failed" | "worker_done";
  readonly reason: string | null;
  readonly copy: string;
  readonly citations: readonly CloseoutCitation[];
  readonly observed_at: string;
  readonly fresh_until: string;
  readonly trust: "trusted" | "untrusted" | "conflicting";
  readonly verification: CloseoutVerification | null;
  readonly record_digest: string;
};
export type CloseoutDecision = {
  readonly decision_id: string;
  readonly state: "made" | "owner_required";
  readonly copy: string;
  readonly citations: readonly CloseoutCitation[];
};
export type CloseoutMemoryCandidate = {
  readonly candidate_id: string;
  readonly verification_evidence_id: string;
  readonly citations: readonly CloseoutCitation[];
};
export type CloseoutPriority = {
  readonly owner_safety_gate: PriorityOwnerSafetyGate;
  readonly customer_impact: PriorityCustomerImpact;
  readonly deadline_bucket: PriorityDeadlineBucket;
  readonly dependency_blocking: PriorityDependencyBlocking;
  readonly irreversible_risk: PriorityIrreversibleRisk;
  readonly effort_cost: PriorityEffortCost;
  readonly stable_identity: string;
};
export type CloseoutTomorrowAction = {
  readonly action_id: string;
  readonly disposition: "executable" | "delegated";
  readonly priority: CloseoutPriority;
  readonly observed_at: string;
  readonly fresh_until: string;
  readonly trust: "trusted" | "untrusted";
  readonly actionable: boolean;
  readonly citations: readonly CloseoutCitation[];
};
export type CloseoutRisk = {
  readonly risk_id: string;
  readonly copy: string;
  readonly citations: readonly CloseoutCitation[];
};
export type EveningCloseoutLimits = {
  readonly max_completions: number;
  readonly max_open: number;
  readonly max_decisions: number;
  readonly max_risks: number;
  readonly max_candidates: number;
  readonly max_sources: number;
  readonly max_citations: number;
  readonly max_evidence: number;
  readonly max_copy_bytes: number;
  readonly max_total_bytes: number;
};
export type TrustedCloseoutVerifier = {
  readonly verifier_id: string;
  readonly key_id: string;
  readonly public_key_fingerprint: string;
};
export type EveningCloseoutInput = {
  readonly schema_version: 1;
  readonly run_id: string;
  readonly correlation_id: string;
  readonly local_date: string;
  readonly generated_at: string;
  readonly source_readiness: CloseoutReadiness;
  readonly source_omissions: readonly string[];
  readonly trusted_verifier: TrustedCloseoutVerifier;
  readonly records: readonly CloseoutRecord[];
  readonly decisions: readonly CloseoutDecision[];
  readonly memory_candidates: readonly CloseoutMemoryCandidate[];
  readonly tomorrow_actions: readonly CloseoutTomorrowAction[];
  readonly risks: readonly CloseoutRisk[];
  readonly limits: EveningCloseoutLimits;
};
export type CloseoutOpenFact = {
  readonly item_id: string;
  readonly state: "open" | "failed" | "uncertain";
  readonly reason: string;
  readonly copy: string;
  readonly citations: readonly CloseoutCitation[];
  readonly record_digest: string;
};
export type CloseoutOmissionReason =
  | "completion_cap" | "open_cap" | "decision_cap" | "risk_cap" | "action_cap"
  | "candidate_cap" | "source_cap" | "citation_cap" | "evidence_cap" | "copy_truncated";
export type CloseoutOmission = { readonly reason: CloseoutOmissionReason; readonly count: number };
export type CloseoutSigningIdentity = {
  readonly schema_version: 1;
  readonly algorithm: "Ed25519";
  readonly key_id: string;
  readonly public_key_spki: string;
  readonly public_key_fingerprint: string;
};
export type CloseoutEnvelope = CloseoutSigningIdentity & { readonly signature: string };
export type CloseoutSigningHandle = {
  readonly identity: CloseoutSigningIdentity;
  readonly clock: () => Date;
  readonly sign: (bytes: Uint8Array) => Uint8Array;
};
export type TrustedCloseoutKey = {
  readonly key_id: string;
  readonly public_key_spki: string;
};
export type EveningCloseoutArtifact = {
  readonly schema_version: 1;
  readonly artifact_id: string;
  readonly run_id: string;
  readonly correlation_id: string;
  readonly local_date: string;
  readonly generated_at: string;
  readonly source_readiness: CloseoutReadiness;
  readonly source_omissions: readonly string[];
  readonly verified_completions: readonly CloseoutRecord[];
  readonly open_or_failed: readonly CloseoutOpenFact[];
  readonly decisions_made: readonly CloseoutDecision[];
  readonly owner_decisions_required: readonly CloseoutDecision[];
  readonly eligible_memory_candidate_ids: readonly string[];
  readonly memory_candidate_support: readonly CloseoutMemoryCandidate[];
  readonly tomorrow_first_action: "none" | CloseoutTomorrowAction;
  readonly unresolved_risks: readonly CloseoutRisk[];
  readonly omissions: readonly CloseoutOmission[];
  readonly omitted_count: number;
  readonly limits: EveningCloseoutLimits;
  readonly canonical_digest: string;
  readonly envelope: CloseoutEnvelope;
};
export type EveningCloseoutErrorCode =
  | "EVENING_CLOSEOUT_INPUT_INVALID"
  | "EVENING_CLOSEOUT_INTEGRITY_FAILURE"
  | "EVENING_CLOSEOUT_IDENTITY_CONFLICT"
  | "EVENING_CLOSEOUT_NOT_FOUND";
export class EveningCloseoutError extends Error {
  readonly name = "EveningCloseoutError";
  constructor(readonly code: EveningCloseoutErrorCode) { super(code); }
}
