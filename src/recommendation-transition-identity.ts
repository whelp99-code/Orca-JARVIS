import type Database from "better-sqlite3";
import type { RecommendationId, Sha256Digest } from "./personal-contracts.js";
import { RecommendationError } from "./recommendation-errors.js";
import { storedRecommendationIdentity, type RecommendationIdentity } from "./recommendation-identity.js";
import { persistenceHash, persistenceRow, persistenceText } from "./personal-persistence-values.js";

export const TERMINAL_TRANSITION_STATES = [
  "accepted", "rejected", "expired", "superseded", "dismissed", "snoozed",
] as const;
export type TerminalTransitionState = (typeof TERMINAL_TRANSITION_STATES)[number];
export type ReplacementRecommendationIdentity = {
  readonly recommendation_id: RecommendationId;
  readonly context_digest: Sha256Digest;
  readonly evidence_digest: Sha256Digest;
  readonly identity_digest: Sha256Digest;
};
export type TerminalTransitionIdentity = {
  readonly recommendation_id: RecommendationId;
  readonly rank: number;
  readonly state: TerminalTransitionState;
  readonly evidence_digest: Sha256Digest;
  readonly occurred_at: string;
  readonly replacement: ReplacementRecommendationIdentity | null;
};
type StoredReplacement = {
  readonly identity: RecommendationIdentity;
  readonly context_digest: unknown;
  readonly evidence_digest: unknown;
};
type StoredTransition = {
  readonly source: RecommendationIdentity;
  readonly base_evidence_digest: unknown;
  readonly rank: unknown;
  readonly state: unknown;
  readonly event_evidence_digest: unknown;
  readonly transition_occurred_at: unknown;
  readonly transition_digest: unknown;
  readonly replacement_recommendation_id: unknown;
  readonly replacement: StoredReplacement | null;
};

function invalid(): never {
  throw new RecommendationError("RECOMMENDATION_INPUT_INVALID");
}
function digest(value: unknown): Sha256Digest {
  const text = persistenceText(value);
  function valid(candidate: string): candidate is Sha256Digest {
    return /^sha256:[0-9a-f]{64}$/.test(candidate);
  }
  return valid(text) ? text : invalid();
}
function rank(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1 && value <= 32 ? value : invalid();
}
function state(value: unknown): "pending" | TerminalTransitionState {
  if (value === "pending") return value;
  return TERMINAL_TRANSITION_STATES.find(candidate => candidate === value) ?? invalid();
}
function nullableText(value: unknown): string | null {
  return value === null ? null : persistenceText(value);
}

export function supersessionEvidenceDigest(
  evidenceDigest: Sha256Digest,
  replacement: ReplacementRecommendationIdentity,
): Sha256Digest {
  return persistenceHash({
    evidence_digest: evidenceDigest,
    replacement_context_digest: replacement.context_digest,
    replacement_evidence_digest: replacement.evidence_digest,
    replacement_identity_digest: replacement.identity_digest,
    replacement_recommendation_id: replacement.recommendation_id,
  });
}

export function transitionDigest(identity: TerminalTransitionIdentity): Sha256Digest {
  return persistenceHash({
    schema_version: 1,
    source_recommendation_id: identity.recommendation_id,
    rank: identity.rank,
    state: identity.state,
    base_evidence_digest: identity.evidence_digest,
    transition_occurred_at: identity.occurred_at,
    replacement: identity.replacement === null ? null : {
      recommendation_id: identity.replacement.recommendation_id,
      context_digest: identity.replacement.context_digest,
      evidence_digest: identity.replacement.evidence_digest,
      identity_digest: identity.replacement.identity_digest,
    },
  });
}

export function validateStoredTransition(input: StoredTransition): string | null {
  const baseEvidence = digest(input.base_evidence_digest);
  const eventEvidence = digest(input.event_evidence_digest);
  const eventState = state(input.state);
  const directReplacement = nullableText(input.replacement_recommendation_id);
  const occurredAt = nullableText(input.transition_occurred_at);
  const storedDigest = nullableText(input.transition_digest);
  if (eventState === "pending") {
    if (eventEvidence !== baseEvidence || occurredAt !== null || storedDigest !== null
      || directReplacement !== null || input.replacement !== null) return invalid();
    return null;
  }
  if (occurredAt === null || storedDigest === null) {
    if (occurredAt !== null || storedDigest !== null || eventEvidence !== baseEvidence
      || eventState === "superseded" || directReplacement !== null || input.replacement !== null) return invalid();
    return null;
  }
  const eventRank = rank(input.rank);
  if (eventState !== "superseded") {
    if (eventEvidence !== baseEvidence || directReplacement !== null || input.replacement !== null) return invalid();
    const expected = transitionDigest({ recommendation_id: input.source.recommendation.id, rank: eventRank,
      state: eventState, evidence_digest: baseEvidence, occurred_at: occurredAt, replacement: null });
    return expected === storedDigest ? null : invalid();
  }
  const replacement = input.replacement;
  if (directReplacement === null || replacement === null
    || directReplacement !== replacement.identity.recommendation.id
    || directReplacement === input.source.recommendation.id) return invalid();
  const replacementContext = digest(replacement.context_digest);
  const replacementEvidence = digest(replacement.evidence_digest);
  if (replacementContext !== replacement.identity.recommendation.payload.context_digest) return invalid();
  const replacementIdentity: ReplacementRecommendationIdentity = {
    recommendation_id: replacement.identity.recommendation.id,
    context_digest: replacementContext,
    evidence_digest: replacementEvidence,
    identity_digest: replacement.identity.identity_digest,
  };
  const expectedEvidence = supersessionEvidenceDigest(baseEvidence, replacementIdentity);
  const expectedTransition = transitionDigest({ recommendation_id: input.source.recommendation.id, rank: eventRank,
    state: eventState, evidence_digest: baseEvidence, occurred_at: occurredAt, replacement: replacementIdentity });
  if (eventEvidence !== expectedEvidence || storedDigest !== expectedTransition) return invalid();
  return directReplacement;
}

export function validateStoredRecommendationEvents(
  database: Database.Database,
  source: RecommendationIdentity,
  baseEvidenceDigest: unknown,
): void {
  const rows = database.prepare(
    `SELECT e.rank,e.state,e.evidence_digest,e.transition_occurred_at,e.transition_digest,
            e.replacement_recommendation_id,rr.context_digest AS replacement_context_digest,
            rr.canonical_digest AS replacement_canonical_digest,rr.evidence_digest AS replacement_evidence_digest,
            rr.canonical_envelope_json AS replacement_envelope_json
     FROM personal_recommendation_action_events e
     LEFT JOIN personal_recommendations rr ON rr.recommendation_id=e.replacement_recommendation_id
     WHERE e.recommendation_id=? ORDER BY e.event_sequence`,
  ).all(source.recommendation.id).map(persistenceRow);
  const replacements = new Map<string, StoredReplacement>();
  for (const row of rows) {
    const direct = nullableText(row["replacement_recommendation_id"]);
    if (direct !== null && !replacements.has(direct)) {
      replacements.set(direct, {
        identity: storedRecommendationIdentity(row["replacement_canonical_digest"], row["replacement_evidence_digest"],
          row["replacement_envelope_json"]),
        context_digest: digest(row["replacement_context_digest"]),
        evidence_digest: digest(row["replacement_evidence_digest"]),
      });
    }
    validateStoredTransition({ source, base_evidence_digest: baseEvidenceDigest, rank: row["rank"], state: row["state"],
      event_evidence_digest: row["evidence_digest"], transition_occurred_at: row["transition_occurred_at"],
      transition_digest: row["transition_digest"], replacement_recommendation_id: direct,
      replacement: direct === null ? null : replacements.get(direct) ?? null });
  }
}
