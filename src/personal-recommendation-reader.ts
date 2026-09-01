import type Database from "better-sqlite3";
import { MemoryProjectionAuthority } from "./memory-projection-authority.js";
import type { RecommendationId } from "./personal-contracts.js";
import { persistenceRow } from "./personal-persistence-values.js";
import {
  reconstructedContextEvidence,
  reconstructedEvidence,
  reconstructedMemoryEvidence,
} from "./personal-recommendation-reconstruction.js";
import type { ReconstructedRecommendation } from "./personal-recommendation-types.js";
import { storedRecommendationIdentity } from "./recommendation-identity.js";
import { validateStoredRecommendationEvents } from "./recommendation-transition-identity.js";

export class PersonalRecommendationReader {
  constructor(private readonly database: Database.Database) {}

  get(id: RecommendationId): ReconstructedRecommendation | undefined {
    const projections = new MemoryProjectionAuthority({ db: this.database });
    if (projections.isSuppressed({ kind: "recommendation", id, component_id: id })) return undefined;
    const value = this.database.prepare(
      `SELECT recommendation_id,context_id,context_digest,canonical_digest,evidence_digest,
              approval_requirement,confidence_class,lifecycle_state,expires_at,created_at
       FROM personal_recommendations WHERE recommendation_id=?`,
    ).get(id);
    if (value === undefined) return undefined;
    const recommendation = persistenceRow(value);
    const identity = this.database.prepare(
      "SELECT canonical_envelope_json FROM personal_recommendations WHERE recommendation_id=?",
    ).get(id);
    if (identity === undefined) return undefined;
    const envelope = persistenceRow(identity)["canonical_envelope_json"];
    if (typeof envelope === "string" && envelope.includes('"source_version":"task18-v1"')) {
      const source = storedRecommendationIdentity(recommendation["canonical_digest"], recommendation["evidence_digest"], envelope);
      validateStoredRecommendationEvents(this.database, source, recommendation["evidence_digest"]);
    }
    const contextEvidence = this.database.prepare(
      `SELECT e.evidence_id,e.source_id,e.evidence_kind AS kind,e.evidence_digest AS digest,
              e.observed_at,e.fresh_until
       FROM personal_context_evidence e
       JOIN personal_recommendations r ON r.context_id=e.context_id
       WHERE r.recommendation_id=? ORDER BY e.position`,
    ).all(id).map(persistenceRow).map(reconstructedContextEvidence);
    const memoryEvidence = this.database.prepare(
      `SELECT m.memory_ref,m.evidence_id,m.source_id,e.evidence_kind AS kind,
              m.evidence_digest AS digest,m.observed_at,m.fresh_until
       FROM personal_context_memory_evidence m
       JOIN personal_context_evidence e
         ON e.context_id=m.context_id AND e.evidence_id=m.evidence_id
       JOIN personal_recommendations r ON r.context_id=m.context_id
       WHERE r.recommendation_id=? ORDER BY e.position,m.memory_ref`,
    ).all(id).map(persistenceRow).map(reconstructedMemoryEvidence);
    const evidence = this.database.prepare(
      `SELECT re.evidence_id,re.source_id,ce.evidence_kind AS kind,
              re.evidence_digest AS digest,re.observed_at
       FROM personal_recommendation_evidence re
       JOIN personal_recommendations r ON r.recommendation_id=re.recommendation_id
       JOIN personal_context_evidence ce
         ON ce.context_id=r.context_id AND ce.evidence_id=re.evidence_id
       WHERE re.recommendation_id=? ORDER BY re.position`,
    ).all(id).map(persistenceRow).map(reconstructedEvidence);
    const actions = projections.visible(this.database.prepare(
      `SELECT a.rank,a.title,a.operation,a.target_digest,
              (SELECT state FROM personal_recommendation_action_events e
               WHERE e.recommendation_id=a.recommendation_id AND e.rank=a.rank
               ORDER BY event_sequence DESC LIMIT 1) AS state
       FROM personal_recommendation_actions a
       WHERE a.recommendation_id=? ORDER BY a.rank`,
    ).all(id).map(persistenceRow), row => ({ kind: "recommendation_action", id,
      component_id: String(row["rank"]) }));
    const events = projections.visible(this.database.prepare(
      `SELECT rank,state,evidence_digest,COALESCE(transition_occurred_at,occurred_at) AS occurred_at,
              occurred_at AS recorded_at,transition_digest,replacement_recommendation_id
       FROM personal_recommendation_action_events WHERE recommendation_id=? ORDER BY event_sequence`,
    ).all(id).map(persistenceRow), row => ({ kind: "recommendation_action", id,
      component_id: String(row["rank"]) }));
    return {
      recommendation,
      context_evidence: contextEvidence,
      memory_evidence: memoryEvidence,
      evidence,
      actions,
      action_events: events,
    };
  }
}
