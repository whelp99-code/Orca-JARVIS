export const RECOMMENDATION_ERROR_CODES = [
  "RECOMMENDATION_INPUT_INVALID",
  "RECOMMENDATION_RANKING_INVALID",
  "RECOMMENDATION_CONTEXT_NOT_FOUND",
  "RECOMMENDATION_CONTEXT_STALE",
  "RECOMMENDATION_IDENTITY_CONFLICT",
  "RECOMMENDATION_EVIDENCE_CONFLICT",
  "RECOMMENDATION_TRANSITION_CONFLICT",
  "RECOMMENDATION_EXPIRED",
  "RECOMMENDATION_SUPERSESSION_CONFLICT",
] as const;

export type RecommendationErrorCode = (typeof RECOMMENDATION_ERROR_CODES)[number];

export class RecommendationError extends Error {
  readonly name = "RecommendationError";

  constructor(readonly code: RecommendationErrorCode) {
    super(code);
  }
}
