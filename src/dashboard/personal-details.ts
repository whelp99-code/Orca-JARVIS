import type { AuthorityDb } from "../db.js";
import { canonicalPersonalContractHash, parseContextSnapshotV1, parseRecommendationV1 } from "../personal-validation.js";
import { Recommendations } from "../recommendations.js";
import type { ContextEvidenceProjection, RecommendationDetailProjection, RecommendationEvidenceProjection } from "./personal-contracts.js";

type EvidenceIdentity = Omit<RecommendationEvidenceProjection, "fresh_until">;
import { dbRow, dbRows, readOnlySnapshot, text } from "./personal-db.js";

export type PersonalLookup<T> = { readonly kind: "found"; readonly value: T } | { readonly kind: "not_found" };

export function recommendationDetail(db: AuthorityDb, id: string, now: Date): PersonalLookup<RecommendationDetailProjection> {
  return readOnlySnapshot(db, () => {
    const raw = db.db.prepare(
      `SELECT recommendation_id,context_id,canonical_digest,evidence_digest,approval_requirement,
              confidence_class,lifecycle_state,expires_at,canonical_envelope_json
       FROM personal_recommendations WHERE recommendation_id=?`,
    ).get(id);
    if (raw === undefined) return { kind: "not_found" };
    const row = dbRow(raw);
    const recommendation = parseRecommendationV1(JSON.parse(text(row, "canonical_envelope_json")));
    if (recommendation.id !== id || canonicalPersonalContractHash(recommendation) !== text(row, "canonical_digest")) {
      throw new PersonalProjectionIntegrityError();
    }
    const projection = new Recommendations(db).project(now.toISOString(), 500);
    const actions = projection.lifecycle_actions.filter((action) => action.recommendation_id === id).map((action) => ({
      rank: action.rank, title: action.title, operation: action.operation, target_digest: action.target_digest,
      state: action.state, owner_decision_required: action.owner_decision_required, current: action.current,
      occurred_at: action.occurred_at, transition_digest: action.transition_digest,
    }));
    const evidence = storedEvidence(db, id, recommendation.evidence);
    return { kind: "found", value: {
      schema_version: 1, resource: "recommendation", recommendation_id: id,
      context_id: text(row, "context_id"), canonical_digest: text(row, "canonical_digest"),
      evidence_digest: text(row, "evidence_digest"), approval_requirement: text(row, "approval_requirement"),
      confidence_class: text(row, "confidence_class"), lifecycle_state: text(row, "lifecycle_state"),
      expires_at: text(row, "expires_at"), state: now.toISOString() >= recommendation.freshness.fresh_until ? "stale" : "ready",
      actions, evidence, conflicts: [...recommendation.payload.conflicts].sort(), omissions: [...recommendation.payload.omissions].sort(),
      deep_links: {
        context_evidence: `/api/v1/contexts/${encodeURIComponent(recommendation.payload.context_id)}`
          + `/evidence?recommendation_id=${encodeURIComponent(id)}`,
      },
    } };
  });
}

export function contextEvidence(db: AuthorityDb, contextId: string, recommendationId: string, now: Date): PersonalLookup<ContextEvidenceProjection> {
  return readOnlySnapshot(db, () => {
    const raw = db.db.prepare(
      `SELECT c.canonical_digest,c.canonical_envelope_json,r.canonical_digest AS recommendation_digest,
              r.canonical_envelope_json AS recommendation_envelope
       FROM personal_context_snapshots c JOIN personal_recommendations r ON r.context_id=c.context_id
       WHERE c.context_id=? AND r.recommendation_id=?`,
    ).get(contextId, recommendationId);
    if (raw === undefined) return { kind: "not_found" };
    const row = dbRow(raw);
    const context = parseContextSnapshotV1(JSON.parse(text(row, "canonical_envelope_json")));
    const recommendation = parseRecommendationV1(JSON.parse(text(row, "recommendation_envelope")));
    if (context.id !== contextId || canonicalPersonalContractHash(context) !== text(row, "canonical_digest")
      || recommendation.id !== recommendationId || recommendation.payload.context_id !== contextId
      || recommendation.payload.context_digest !== text(row, "canonical_digest")
      || canonicalPersonalContractHash(recommendation) !== text(row, "recommendation_digest")) {
      throw new PersonalProjectionIntegrityError();
    }
    return { kind: "found", value: {
      schema_version: 1, resource: "context-evidence", context_id: contextId, recommendation_id: recommendationId,
      state: contextState(context.freshness.state, context.freshness.fresh_until, now),
      freshness: { state: context.freshness.state, fresh_until: context.freshness.fresh_until },
      evidence: context.evidence.map((item) => ({ ...item, fresh_until: context.expires_at })),
      conflicts: [...context.payload.conflicts].sort(), omissions: [...context.payload.omissions].sort(),
    } };
  });
}

function storedEvidence(db: AuthorityDb, recommendationId: string, expected: readonly EvidenceIdentity[]): readonly RecommendationEvidenceProjection[] {
  const rows = dbRows(db.db.prepare(
    `SELECT e.evidence_id,e.source_id,e.evidence_kind,e.evidence_digest,e.observed_at,e.fresh_until
     FROM personal_recommendation_evidence r JOIN personal_recommendations p ON p.recommendation_id=r.recommendation_id
     JOIN personal_context_evidence e ON e.context_id=p.context_id AND e.evidence_id=r.evidence_id
     WHERE r.recommendation_id=? ORDER BY r.position`,
  ).all(recommendationId));
  return rows.map((row) => {
    const evidenceId = text(row, "evidence_id");
    const digest = text(row, "evidence_digest");
    const matching = expected.find((item) => item.evidence_id === evidenceId && item.digest === digest);
    if (matching === undefined) throw new PersonalProjectionIntegrityError();
    return { evidence_id: evidenceId, source_id: text(row, "source_id"), kind: text(row, "evidence_kind"), digest,
      observed_at: text(row, "observed_at"), fresh_until: text(row, "fresh_until") };
  });
}

function contextState(state: string, freshUntil: string, now: Date): "ready" | "stale" | "no_data" | "offline" | "degraded" {
  if (state === "fresh") return now.toISOString() < freshUntil ? "ready" : "stale";
  if (state === "stale" || state === "no_data" || state === "offline") return state;
  return "degraded";
}

export class PersonalProjectionIntegrityError extends Error {
  readonly name = "PersonalProjectionIntegrityError";
  constructor() { super("PERSONAL_PROJECTION_INTEGRITY_FAILURE"); }
}
