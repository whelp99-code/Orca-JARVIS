import type { RecommendationId, Sha256Digest } from "./personal-contracts.js";
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
  readonly recommendation_id: RecommendationId;
  readonly rank: number;
  readonly state: ActionState;
  readonly evidence_digest: Sha256Digest;
  readonly occurred_at: string;
};
export type StoredRecommendation = {
  readonly recommendation_id: RecommendationId;
  readonly canonical_digest: Sha256Digest;
  readonly evidence_digest: Sha256Digest;
};
export type ReconstructedRecommendation = {
  readonly recommendation: PersistenceRow;
  readonly context_evidence: readonly PersistenceRow[];
  readonly evidence: readonly PersistenceRow[];
  readonly actions: readonly PersistenceRow[];
  readonly action_events: readonly PersistenceRow[];
};
