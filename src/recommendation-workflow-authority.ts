import type Database from "better-sqlite3";
import { JarvisError, type AuthorityDb } from "./db.js";
import { contextsWithUnavailableLocalSource } from "./local-observation-availability.js";
import { contextsWithClosedMemorySource } from "./personal-memory-availability.js";
import { canonicalPersonalContractHash, parseContextSnapshotV1, parseRecommendationV1 } from "./personal-validation.js";
import { persistenceHash, persistenceRow, persistenceText } from "./personal-persistence-values.js";
import { storedRecommendationIdentity } from "./recommendation-identity.js";
import type { ParsedRecommendationWorkflowRequest } from "./recommendation-workflow-input.js";

export type RecommendationWorkflowBinding = {
  readonly recommendation_id: string; readonly action_rank: number;
  readonly context_id: string; readonly canonical_digest: string;
  readonly evidence_digest: string; readonly context_digest: string;
  readonly action_digest: string; readonly persistence_digest: string;
  readonly freshness_digest: string; readonly lifecycle_digest: string;
  readonly target_digest: string; readonly args_digest: string;
  readonly proposal_digest: string; readonly requested_by_principal_id: string;
  readonly authenticated_session_id: string; readonly idempotency_key: string;
};
export type CanonicalRecommendationWorkflowState = RecommendationWorkflowBinding & {
  readonly action: Readonly<Record<string, unknown>>; readonly expiresAt: string;
};
const ELIGIBLE = new Set(["eligible", "presented", "selected"]);
function fail(): never { throw new JarvisError("RECOMMENDATION_WORKFLOW_NOT_ELIGIBLE"); }
function exactEvidence(
  expected: readonly Readonly<Record<string, unknown>>[], actual: readonly Readonly<Record<string, unknown>>[],
): boolean {
  return expected.length === actual.length && expected.every((item, index) => {
    const row = actual[index];
    return row !== undefined && Object.entries(item).every(([key, value]) => row[key] === value);
  });
}
function contextItems(context: ReturnType<typeof parseContextSnapshotV1>): number {
  const payload = context.payload;
  return payload.included_observation_refs.length + payload.included_memory_refs.length
    + payload.excluded_refs.length + payload.pending_authority_refs.length
    + payload.conflicts.length + payload.omissions.length;
}
function query(database: Database.Database, request: ParsedRecommendationWorkflowRequest): Readonly<Record<string, unknown>> {
  const value = database.prepare(`SELECT r.*,
    c.context_id AS stored_context_id,c.idempotency_key AS context_idempotency_key,c.version AS context_version,
    c.purpose AS context_purpose,c.declared_query AS context_query,c.canonical_digest AS stored_context_digest,
    c.persistence_digest AS context_persistence_digest,c.canonical_envelope_json AS context_envelope,
    c.payload_state AS context_payload_state,c.freshness_state AS context_freshness_state,
    c.fresh_until AS context_fresh_until,c.item_count AS context_item_count,
    c.observation_count AS context_observation_count,c.evidence_count AS context_evidence_count,
    c.memory_count AS context_memory_count,c.max_items AS context_max_items,
    c.max_excerpt_bytes AS context_max_excerpt_bytes,c.max_total_bytes AS context_max_total_bytes,
    c.conflict_count AS context_conflict_count,c.omission_count AS context_omission_count,
    c.observed_at AS context_observed_at,c.valid_at AS context_valid_at,
    c.expires_at AS context_expires_at,c.created_at AS context_created_at,
    a.recommendation_id AS action_recommendation_id,a.rank AS stored_action_rank,
    a.title,a.operation,a.target_digest,a.initial_state,
    e.event_sequence,e.rank AS event_rank,e.state AS action_state,e.evidence_digest AS event_evidence_digest,
    e.occurred_at AS event_occurred_at,e.transition_occurred_at,e.transition_digest,
    e.replacement_recommendation_id,
    (SELECT MIN(x.event_sequence) FROM personal_recommendation_action_events x
      WHERE x.recommendation_id=a.recommendation_id) AS first_event_sequence,
    (SELECT COUNT(*) FROM personal_context_snapshots x
      WHERE x.purpose=c.purpose AND x.declared_query=c.declared_query) AS context_version_count,
    (SELECT MAX(x.version) FROM personal_context_snapshots x
      WHERE x.purpose=c.purpose AND x.declared_query=c.declared_query) AS context_max_version,
    (SELECT COUNT(*) FROM personal_recommendation_action_events x
      WHERE x.recommendation_id=a.recommendation_id AND x.rank=a.rank) AS event_count,
    (SELECT occurred_at FROM personal_context_audit_events x
      WHERE x.event_type='recommendation_recorded' AND x.subject_id=r.recommendation_id) AS recommendation_recorded_at,
    (SELECT subject_digest FROM personal_context_audit_events x
      WHERE x.event_type='recommendation_recorded' AND x.subject_id=r.recommendation_id) AS recommendation_audit_digest
    FROM personal_recommendations r JOIN personal_context_snapshots c ON c.context_id=r.context_id
    JOIN personal_recommendation_actions a ON a.recommendation_id=r.recommendation_id
    JOIN personal_recommendation_action_events e ON e.event_sequence=(
      SELECT MAX(x.event_sequence) FROM personal_recommendation_action_events x
      WHERE x.recommendation_id=a.recommendation_id AND x.rank=a.rank)
    WHERE r.recommendation_id=? AND a.rank=?`).get(request.recommendationId, request.actionRank);
  return value === undefined ? fail() : persistenceRow(value);
}
function contextEvidence(
  database: Database.Database, context: ReturnType<typeof parseContextSnapshotV1>,
): { readonly exact: boolean; readonly memory: readonly Readonly<Record<string, unknown>>[] } {
  const actual = database.prepare(`SELECT position,evidence_id,source_id,evidence_kind,
    evidence_digest,observed_at,freshness_state,fresh_until
    FROM personal_context_evidence WHERE context_id=? ORDER BY position`).all(context.id).map(persistenceRow);
  const expected = context.evidence.map((item, position) => ({
    position, evidence_id: item.evidence_id, source_id: item.source_id,
    evidence_kind: item.kind, evidence_digest: item.digest, observed_at: item.observed_at,
  }));
  const memory = database.prepare(`SELECT m.memory_ref,m.evidence_id,m.source_id,m.evidence_digest AS digest,
    m.observed_at,m.fresh_until FROM personal_context_memory_evidence m
    JOIN personal_context_evidence e ON e.context_id=m.context_id AND e.evidence_id=m.evidence_id
    WHERE m.context_id=? ORDER BY e.position,m.memory_ref`).all(context.id).map(persistenceRow);
  const memoryExact = context.payload.included_memory_refs.length === memory.length
    && context.payload.included_memory_refs.every((reference, index) => memory[index]?.["memory_ref"] === reference);
  const freshnessExact = actual.every(row => row["freshness_state"] === "fresh"
    && typeof row["fresh_until"] === "string" && row["fresh_until"] >= context.expires_at);
  return { exact: exactEvidence(expected, actual) && memoryExact && freshnessExact, memory };
}
function recommendationEvidence(
  database: Database.Database, request: ParsedRecommendationWorkflowRequest,
  recommendation: ReturnType<typeof parseRecommendationV1>,
): boolean {
  const actual = database.prepare(`SELECT position,evidence_id,source_id,evidence_digest,observed_at
    FROM personal_recommendation_evidence WHERE recommendation_id=? ORDER BY position`
  ).all(request.recommendationId).map(persistenceRow);
  const expected = recommendation.evidence.map((item, position) => ({
    position, evidence_id: item.evidence_id, source_id: item.source_id,
    evidence_digest: item.digest, observed_at: item.observed_at,
  }));
  return exactEvidence(expected, actual);
}
function load(
  database: Database.Database, request: ParsedRecommendationWorkflowRequest,
): CanonicalRecommendationWorkflowState {
  const row = query(database, request);
  const envelope = persistenceText(row["canonical_envelope_json"]);
  const recommendation = parseRecommendationV1(JSON.parse(envelope));
  const context = parseContextSnapshotV1(JSON.parse(persistenceText(row["context_envelope"])));
  const canonicalDigest = canonicalPersonalContractHash(recommendation);
  const contextDigest = canonicalPersonalContractHash(context);
  const evidenceDigest = persistenceHash(recommendation.evidence);
  const identity = storedRecommendationIdentity(canonicalDigest, evidenceDigest, envelope);
  const persistenceDigest = persistenceHash({
    approval_requirement: identity.provenance.approval_requirement,
    canonical_digest: canonicalDigest,
    confidence_class: identity.provenance.confidence_class,
  });
  const evidence = contextEvidence(database, context);
  const contextPersistenceDigest = persistenceHash({ canonical_digest: contextDigest, memory_evidence: evidence.memory });
  const material = identity.provenance.actions[request.actionRank - 1];
  const action = {
    rank: request.actionRank, title: row["title"],
    operation: row["operation"], target_digest: row["target_digest"],
  };
  const recommendationExact = row["recommendation_id"] === recommendation.id
    && row["idempotency_key"] === recommendation.idempotency_key
    && row["context_id"] === recommendation.payload.context_id
    && row["context_digest"] === recommendation.payload.context_digest
    && row["canonical_digest"] === canonicalDigest && row["evidence_digest"] === evidenceDigest
    && row["persistence_digest"] === persistenceDigest
    && row["approval_requirement"] === identity.provenance.approval_requirement
    && row["confidence_class"] === identity.provenance.confidence_class
    && row["lifecycle_state"] === recommendation.payload.state
    && row["observed_at"] === recommendation.observed_at && row["valid_at"] === recommendation.valid_at
    && row["expires_at"] === recommendation.expires_at && row["created_at"] === recommendation.created_at;
  const contextExact = row["stored_context_id"] === context.id
    && row["context_idempotency_key"] === context.idempotency_key
    && row["context_purpose"] === context.payload.purpose && row["context_query"] === context.payload.query
    && row["context_version_count"] === row["context_max_version"]
    && typeof row["context_version"] === "number" && row["context_version"] >= 1
    && row["stored_context_digest"] === contextDigest
    && row["context_persistence_digest"] === contextPersistenceDigest
    && row["context_payload_state"] === context.payload.state
    && row["context_freshness_state"] === context.freshness.state
    && row["context_fresh_until"] === context.freshness.fresh_until
    && row["context_item_count"] === contextItems(context)
    && row["context_observation_count"] === context.payload.included_observation_refs.length
    && row["context_evidence_count"] === context.evidence.length
    && row["context_memory_count"] === context.payload.included_memory_refs.length
    && row["context_max_items"] === context.payload.budgets.max_items
    && row["context_max_excerpt_bytes"] === context.payload.budgets.max_excerpt_bytes
    && row["context_max_total_bytes"] === context.payload.budgets.max_total_bytes
    && row["context_conflict_count"] === context.payload.conflicts.length
    && row["context_omission_count"] === context.payload.omissions.length
    && row["context_observed_at"] === context.observed_at && row["context_valid_at"] === context.valid_at
    && row["context_expires_at"] === context.expires_at && row["context_created_at"] === context.created_at;
  const actionExact = material !== undefined && row["action_recommendation_id"] === recommendation.id
    && row["stored_action_rank"] === request.actionRank && row["initial_state"] === "pending"
    && row["title"] === material.title && row["operation"] === material.operation
    && row["target_digest"] === material.target_digest && row["event_count"] === 1
    && row["event_rank"] === request.actionRank && row["action_state"] === "pending"
    && row["event_sequence"] === Number(row["first_event_sequence"]) + request.actionRank - 1
    && row["event_evidence_digest"] === evidenceDigest
    && row["event_occurred_at"] === row["recommendation_recorded_at"]
    && row["recommendation_audit_digest"] === canonicalDigest
    && row["transition_occurred_at"] === null && row["transition_digest"] === null
    && row["replacement_recommendation_id"] === null;
  if (!recommendationExact || !contextExact || !actionExact || !evidence.exact
    || !recommendationEvidence(database, request, recommendation)
    || recommendation.payload.context_digest !== contextDigest
    || row["approval_requirement"] !== "owner" || !ELIGIBLE.has(String(row["lifecycle_state"]))) return fail();
  return {
    recommendation_id: request.recommendationId, action_rank: request.actionRank, context_id: context.id,
    canonical_digest: canonicalDigest, evidence_digest: evidenceDigest, context_digest: contextDigest,
    action_digest: persistenceHash(action), persistence_digest: persistenceDigest,
    freshness_digest: persistenceHash({ recommendation: recommendation.freshness, context: context.freshness }),
    lifecycle_digest: persistenceHash({
      lifecycle_state: row["lifecycle_state"], action_state: row["action_state"],
      lifecycle_identity: row["event_evidence_digest"],
    }),
    target_digest: persistenceHash({ repository: request.repository, environment: request.environment }),
    args_digest: persistenceHash(request.workflowArgs), proposal_digest: "",
    requested_by_principal_id: request.principalId, authenticated_session_id: request.sessionId,
    idempotency_key: "", action,
    expiresAt: [recommendation.expires_at, recommendation.freshness.fresh_until,
      context.expires_at, context.freshness.fresh_until].sort()[0] ?? fail(),
  };
}
/**
 * The canonical state a workflow request may rest on, or a refusal.
 *
 * Execution has to ask what every reader already asks. A recommendation whose local source no longer
 * matches, or whose memory the owner closed, is not work this database offers any more: the
 * projection has withdrawn it and the brief has stopped carrying it. The digests checked here would
 * all still agree, because none of them is about that - so staging, binding or running it would
 * carry out something the owner had withdrawn, and agree with itself the whole way.
 */
export function loadRecommendationWorkflowAuthority(
  authority: AuthorityDb,
  request: ParsedRecommendationWorkflowRequest,
  now: string,
): CanonicalRecommendationWorkflowState {
  const state = loaded(authority.db, request);
  if (contextsWithUnavailableLocalSource(authority.db, [state.context_id], now).has(state.context_id)) {
    throw new JarvisError("RECOMMENDATION_SOURCE_UNAVAILABLE");
  }
  if (contextsWithClosedMemorySource(authority, [state.context_id]).has(state.context_id)) {
    throw new JarvisError("RECOMMENDATION_MEMORY_SOURCE_CLOSED");
  }
  return state;
}

function loaded(
  database: Database.Database,
  request: ParsedRecommendationWorkflowRequest,
): CanonicalRecommendationWorkflowState {
  try { return load(database, request); }
  catch (error) { if (error instanceof JarvisError) throw error; return fail(); }
}
