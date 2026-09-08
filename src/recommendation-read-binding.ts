import type Database from "better-sqlite3";
import type { RecommendationV1 } from "./personal-contracts.js";
import { persistenceHash, persistenceRow } from "./personal-persistence-values.js";
import { RecommendationError } from "./recommendation-errors.js";
import type { RecommendationIdentity } from "./recommendation-identity.js";
import type { RecommendationProvenance } from "./recommendation-provenance.js";

function invalid(): never { throw new RecommendationError("RECOMMENDATION_INPUT_INVALID"); }
type Row = Readonly<Record<string, unknown>>;

export function assertRecommendationMaterial(recommendation: RecommendationV1, provenance: RecommendationProvenance): void {
  const ranked = provenance.ranking.actions.filter(action => action.rank !== null);
  const materials = new Map(provenance.actions.map(action => [action.action_id, action]));
  if (provenance.ranking.status !== "ranked" || ranked.length === 0 || ranked.length !== materials.size
    || materials.size !== provenance.actions.length || ranked.length !== recommendation.payload.actions.length
    || recommendation.authority.authority_kind !== "none") return invalid();
  for (const [index, decision] of ranked.entries()) {
    const material = materials.get(decision.action_id);
    const action = recommendation.payload.actions.find(item => item.rank === decision.rank);
    if (decision.rank !== index + 1 || decision.disposition === "excluded" || decision.disposition === "abstained"
      || material === undefined || action === undefined || action.title !== material.title
      || action.operation !== material.operation || action.target_digest !== material.target_digest) return invalid();
  }
  if ((provenance.approval_requirement === "owner") !== ranked.some(action => action.disposition === "owner_gate_required")) return invalid();
}

export function assertRecommendationRow(row: Row, recommendation: RecommendationV1, provenance?: RecommendationProvenance): void {
  const expected = {
    recommendation_id: recommendation.id, idempotency_key: recommendation.idempotency_key,
    context_id: recommendation.payload.context_id, context_digest: recommendation.payload.context_digest,
    lifecycle_state: recommendation.payload.state, observed_at: recommendation.observed_at, valid_at: recommendation.valid_at,
    expires_at: recommendation.expires_at, created_at: recommendation.created_at,
  };
  if (Object.entries(expected).some(([key, value]) => row[key] !== value)) return invalid();
  if (provenance !== undefined && (row["approval_requirement"] !== provenance.approval_requirement
    || row["confidence_class"] !== provenance.confidence_class)) return invalid();
  if (row["persistence_digest"] !== persistenceHash({ canonical_digest: row["canonical_digest"],
    approval_requirement: row["approval_requirement"], confidence_class: row["confidence_class"] })) return invalid();
}

export function assertRecommendationAction(row: Row, recommendation: RecommendationV1): void {
  const action = recommendation.payload.actions.find(item => item.rank === row["rank"]);
  if (action === undefined || row["title"] !== action.title || row["operation"] !== action.operation
    || row["target_digest"] !== action.target_digest) return invalid();
}

export function validateRecommendationReadRows(database: Database.Database, source: RecommendationIdentity, expectedId: string): void {
  if (expectedId !== source.recommendation.id) return invalid();
  const row = database.prepare("SELECT * FROM personal_recommendations WHERE recommendation_id=?").get(expectedId);
  if (row === undefined) return invalid();
  assertRecommendationRow(persistenceRow(row), source.recommendation, source.provenance);
  const actions = database.prepare("SELECT rank,title,operation,target_digest FROM personal_recommendation_actions WHERE recommendation_id=? ORDER BY rank")
    .all(expectedId).map(persistenceRow);
  if (actions.length !== source.recommendation.payload.actions.length) return invalid();
  for (const action of actions) assertRecommendationAction(action, source.recommendation);
}
