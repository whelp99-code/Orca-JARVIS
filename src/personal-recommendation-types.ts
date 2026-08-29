import type { Evidence, RecommendationId, Sha256Digest, UtcTimestamp } from "./personal-contracts.js";
import type { PersistenceRow } from "./personal-persistence-values.js";

export const APPROVAL_REQUIREMENTS = ["none", "owner"] as const;
export const CONFIDENCE_CLASSES = ["low", "medium", "high"] as const;
export const ACTION_STATES = ["accepted", "rejected", "expired", "superseded", "dismissed", "snoozed"] as const;

type ApprovalRequirement = (typeof APPROVAL_REQUIREMENTS)[number];
type ConfidenceClass = (typeof CONFIDENCE_CLASSES)[number];
type ActionState = (typeof ACTION_STATES)[number];

export function isApprovalRequirement(value: string): value is ApprovalRequirement {
  return APPROVAL_REQUIREMENTS.some(candidate => candidate === value);
}
export function isConfidenceClass(value: string): value is ConfidenceClass {
  return CONFIDENCE_CLASSES.some(candidate => candidate === value);
}
export function isActionState(value: string): value is ActionState {
  return ACTION_STATES.some(candidate => candidate === value);
}

export type RecommendationPersistenceInput = {
  readonly recommendation: unknown;
  readonly approval_requirement: ApprovalRequirement;
  readonly confidence_class: ConfidenceClass;
};
export type RecommendationActionTransition = {
  readonly recommendation_id: string;
  readonly rank: number;
  readonly state: ActionState;
  readonly evidence_digest: string;
  readonly occurred_at: string;
  readonly replacement_recommendation_id?: string;
  readonly replacement_context_digest?: string;
  readonly replacement_evidence_digest?: string;
};
export type StoredRecommendation = {
  readonly recommendation_id: RecommendationId;
  readonly canonical_digest: Sha256Digest;
  readonly evidence_digest: Sha256Digest;
};
export type ReconstructedContextEvidence = Evidence & {
  readonly fresh_until: UtcTimestamp;
};
export type ReconstructedMemoryEvidenceBinding = ReconstructedContextEvidence & {
  readonly memory_ref: string;
};
export type ReconstructedRecommendation = {
  readonly recommendation: PersistenceRow;
  readonly context_evidence: readonly ReconstructedContextEvidence[];
  readonly memory_evidence: readonly ReconstructedMemoryEvidenceBinding[];
  readonly evidence: readonly Evidence[];
  readonly actions: readonly PersistenceRow[];
  readonly action_events: readonly PersistenceRow[];
};
