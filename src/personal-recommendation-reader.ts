import type Database from "better-sqlite3";
import type { RecommendationId } from "./personal-contracts.js";
import { persistenceRow } from "./personal-persistence-values.js";
import type { ReconstructedRecommendation } from "./personal-recommendation-types.js";

export class PersonalRecommendationReader {
  constructor(private readonly database: Database.Database) {}

  get(id: RecommendationId): ReconstructedRecommendation | undefined {
    const value = this.database.prepare(
      `SELECT recommendation_id,context_id,context_digest,canonical_digest,evidence_digest,
              approval_requirement,confidence_class,lifecycle_state,expires_at,created_at
       FROM personal_recommendations WHERE recommendation_id=?`,
    ).get(id);
    if (value === undefined) return undefined;
    const recommendation = persistenceRow(value);
    const contextEvidence = this.database.prepare(
      `SELECT e.evidence_id,e.source_id,e.evidence_kind AS kind,e.evidence_digest AS digest,e.observed_at
       FROM personal_context_evidence e
       JOIN personal_recommendations r ON r.context_id=e.context_id
       WHERE r.recommendation_id=? ORDER BY e.position`,
    ).all(id).map(persistenceRow);
    const evidence = this.database.prepare(
      "SELECT evidence_id,source_id,evidence_digest AS digest,observed_at FROM personal_recommendation_evidence WHERE recommendation_id=? ORDER BY position",
    ).all(id).map(persistenceRow);
    const actions = this.database.prepare(
      `SELECT a.rank,a.title,a.operation,a.target_digest,
              (SELECT state FROM personal_recommendation_action_events e
               WHERE e.recommendation_id=a.recommendation_id AND e.rank=a.rank
               ORDER BY event_sequence DESC LIMIT 1) AS state
       FROM personal_recommendation_actions a
       WHERE a.recommendation_id=? ORDER BY a.rank`,
    ).all(id).map(persistenceRow);
    const events = this.database.prepare(
      "SELECT rank,state,evidence_digest,occurred_at FROM personal_recommendation_action_events WHERE recommendation_id=? ORDER BY event_sequence",
    ).all(id).map(persistenceRow);
    return { recommendation, context_evidence: contextEvidence, evidence, actions, action_events: events };
  }
}
