import type { AuthorityDb } from "../db.js";
import { canonicalPersonalContractHash, parseContextSnapshotV1, parseRecommendationV1 } from "../personal-validation.js";
import { persistenceHash } from "../personal-persistence-values.js";
import { Recommendations } from "../recommendations.js";
import type { ContextEvidenceProjection, RecommendationDetailProjection, RecommendationEvidenceProjection } from "./personal-contracts.js";
import { dbRow, dbRows, numberValue, readOnlySnapshot, text } from "./personal-db.js";

type EvidenceIdentity = Omit<RecommendationEvidenceProjection, "fresh_until">;

export type PersonalLookup<T> = { readonly kind: "found"; readonly value: T } | { readonly kind: "not_found" };

export function recommendationDetail(db: AuthorityDb, id: string, now: Date): PersonalLookup<RecommendationDetailProjection> {
  return readOnlySnapshot(db, () => {
    const raw = db.db.prepare(
      `SELECT r.recommendation_id,r.context_id,r.context_digest,r.canonical_digest,r.evidence_digest,r.persistence_digest,
              r.approval_requirement,r.confidence_class,r.lifecycle_state,r.expires_at,r.canonical_envelope_json,
              c.canonical_digest AS stored_context_digest,c.canonical_envelope_json AS context_envelope
       FROM personal_recommendations r JOIN personal_context_snapshots c ON c.context_id=r.context_id
       WHERE r.recommendation_id=?`,
    ).get(id);
    if (raw === undefined) return { kind: "not_found" };
    const row = dbRow(raw);
    const recommendation = parseRecommendationV1(JSON.parse(text(row, "canonical_envelope_json")));
    const context = parseContextSnapshotV1(JSON.parse(text(row, "context_envelope")));
    if (recommendation.id !== id || canonicalPersonalContractHash(recommendation) !== text(row, "canonical_digest")
      || recommendation.payload.context_id !== context.id
      || recommendation.payload.context_digest !== canonicalPersonalContractHash(context)
      || text(row, "context_digest") !== text(row, "stored_context_digest")
      || text(row, "stored_context_digest") !== canonicalPersonalContractHash(context)
      || text(row, "evidence_digest") !== persistenceHash(recommendation.evidence)
      || text(row, "lifecycle_state") !== recommendation.payload.state
      || text(row, "expires_at") !== recommendation.expires_at
      || text(row, "persistence_digest") !== persistenceHash({ approval_requirement: text(row, "approval_requirement"),
        canonical_digest: text(row, "canonical_digest"), confidence_class: text(row, "confidence_class") })) {
      throw new PersonalProjectionIntegrityError();
    }
    const projection = new Recommendations(db).project(now.toISOString(), 500);
    const actions = projection.lifecycle_actions.filter((action) => action.recommendation_id === id).map((action) => ({
      rank: action.rank, title: action.title, operation: action.operation, target_digest: action.target_digest,
      state: action.state, owner_decision_required: action.owner_decision_required, current: action.current,
      occurred_at: action.occurred_at, transition_digest: action.transition_digest,
    }));
    if (actions.length !== recommendation.payload.actions.length || actions.some((action, index) => {
      const canonical = recommendation.payload.actions[index];
      return canonical === undefined || action.rank !== canonical.rank || action.title !== canonical.title
        || action.operation !== canonical.operation || action.target_digest !== canonical.target_digest;
    })) throw new PersonalProjectionIntegrityError();
    const evidence = storedRecommendationEvidence(db, id, recommendation.evidence);
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
    validateContextEvidence(db, contextId, context.evidence);
    return { kind: "found", value: {
      schema_version: 1, resource: "context-evidence", context_id: contextId, recommendation_id: recommendationId,
      state: contextState(context.freshness.state, context.freshness.fresh_until, now),
      freshness: { state: context.freshness.state, fresh_until: context.freshness.fresh_until },
      evidence: context.evidence.map((item) => ({ ...item, fresh_until: context.expires_at })),
      conflicts: [...context.payload.conflicts].sort(), omissions: [...context.payload.omissions].sort(),
    } };
  });
}

function storedRecommendationEvidence(
  db: AuthorityDb,
  recommendationId: string,
  expected: readonly EvidenceIdentity[],
): readonly RecommendationEvidenceProjection[] {
  const rows = dbRows(db.db.prepare(
    `SELECT r.position AS recommendation_position,e.position AS context_position,
            e.evidence_id,e.source_id,e.evidence_kind,e.evidence_digest,e.observed_at
     FROM personal_recommendation_evidence r JOIN personal_recommendations p ON p.recommendation_id=r.recommendation_id
     JOIN personal_context_evidence e ON e.context_id=p.context_id AND e.evidence_id=r.evidence_id
     WHERE r.recommendation_id=? ORDER BY r.position`,
  ).all(recommendationId));
  if (rows.length !== expected.length) throw new PersonalProjectionIntegrityError();
  return rows.map((row, index) => {
    const canonical = expected[index];
    if (canonical === undefined || numberValue(row, "recommendation_position") !== index
      || numberValue(row, "context_position") !== index || !evidenceMatches(row, canonical)) {
      throw new PersonalProjectionIntegrityError();
    }
    return { ...canonical, fresh_until: null };
  });
}

function validateContextEvidence(db: AuthorityDb, contextId: string, expected: readonly EvidenceIdentity[]): void {
  const rows = dbRows(db.db.prepare(
    `SELECT position,evidence_id,source_id,evidence_kind,evidence_digest,observed_at
     FROM personal_context_evidence WHERE context_id=? ORDER BY position`,
  ).all(contextId));
  if (rows.length !== expected.length) throw new PersonalProjectionIntegrityError();
  rows.forEach((row, index) => {
    const canonical = expected[index];
    if (canonical === undefined || numberValue(row, "position") !== index || !evidenceMatches(row, canonical)) {
      throw new PersonalProjectionIntegrityError();
    }
  });
}

function evidenceMatches(row: Readonly<Record<string, unknown>>, expected: EvidenceIdentity): boolean {
  return text(row, "evidence_id") === expected.evidence_id && text(row, "source_id") === expected.source_id
    && text(row, "evidence_kind") === expected.kind && text(row, "evidence_digest") === expected.digest
    && text(row, "observed_at") === expected.observed_at;
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
