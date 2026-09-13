import type { AuthorityDb } from "./db.js";
import { contextsWithUnavailableLocalSource } from "./local-observation-availability.js";
import { contextsWithClosedMemorySource } from "./personal-memory-availability.js";
import type { Sha256Digest } from "./personal-contracts.js";
import { RecommendationError } from "./recommendation-errors.js";
import { storedRecommendationIdentity, type RecommendationIdentity } from "./recommendation-identity.js";
import { persistenceRow, persistenceText } from "./personal-persistence-values.js";
import { validateStoredRecommendationEvents, validateStoredTransition } from "./recommendation-transition-identity.js";
import type { RecommendationEvidenceKind } from "./recommendation-provenance.js";

export type RecommendationLifecycleState = "pending" | "accepted" | "rejected" | "expired" | "superseded";
export type ProjectedEvidenceLink = {
  readonly ref: string;
  readonly kind: RecommendationEvidenceKind;
  readonly context_evidence_id: string | null;
  readonly digest: string;
};
export type ProjectedRecommendationAction = {
  readonly recommendation_id: string;
  readonly context_id: string;
  readonly context_digest: string;
  readonly canonical_digest: string;
  readonly context_evidence_digest: string;
  readonly evidence_digest: string;
  readonly identity_digest: Sha256Digest;
  readonly provenance_digest: Sha256Digest;
  readonly evidence_links: readonly ProjectedEvidenceLink[];
  readonly rank: number;
  readonly title: string;
  readonly operation: string;
  readonly target_digest: string;
  readonly approval_requirement: "none" | "owner";
  readonly confidence_class: "low" | "medium" | "high";
  readonly owner_decision_required: boolean;
  readonly state: RecommendationLifecycleState;
  readonly replacement_recommendation_id: string | null;
  readonly occurred_at: string;
  readonly recorded_at: string;
  readonly transition_digest: string | null;
  readonly current: boolean;
  readonly executable: false;
  readonly expires_at: string;
};
export type RecommendationWarning = {
  readonly recommendation_id: string;
  readonly code: "RECOMMENDATION_EXPIRED" | "RECOMMENDATION_MEMORY_SOURCE_CLOSED"
    | "RECOMMENDATION_SOURCE_UNAVAILABLE" | "RECOMMENDATION_STALE";
  readonly deadline: string;
};
export type RecommendationReadProjection = {
  readonly generated_at: string;
  readonly next_actions: readonly ProjectedRecommendationAction[];
  readonly lifecycle_actions: readonly ProjectedRecommendationAction[];
  readonly owner_decisions_needed: readonly ProjectedRecommendationAction[];
  readonly conflicts: readonly string[];
  readonly omissions: readonly string[];
  readonly warnings: readonly RecommendationWarning[];
};
type EnvelopeSummary = {
  readonly conflicts: readonly string[];
  readonly omissions: readonly string[];
  readonly ownerRanks: ReadonlySet<number>;
  readonly linksByRank: ReadonlyMap<number, readonly ProjectedEvidenceLink[]>;
  readonly identity: RecommendationIdentity;
};
function summary(canonical: unknown, evidence: unknown, envelope: unknown): EnvelopeSummary {
  const identity = storedRecommendationIdentity(canonical, evidence, envelope);
  const actions = identity.provenance.ranking.actions;
  const links = identity.provenance.linux_evidence;
  const ownerRanks = new Set(actions.filter(action => action.disposition === "owner_gate_required")
    .flatMap(action => action.rank === null ? [] : [action.rank]));
  const linksByRank = new Map<number, readonly ProjectedEvidenceLink[]>();
  for (const action of actions) {
    if (action.rank === null) continue;
    const refs = new Set(Object.values(action.rationale.citations).filter((value): value is string => value !== null));
    linksByRank.set(action.rank, links.filter(link => refs.has(link.ref)));
  }
  return { conflicts: identity.recommendation.payload.conflicts, omissions: identity.recommendation.payload.omissions,
    ownerRanks, linksByRank, identity };
}
function lifecycle(value: unknown): RecommendationLifecycleState {
  const state = persistenceText(value);
  switch (state) {
    case "pending": case "accepted": case "rejected": case "expired": case "superseded": return state;
    default: throw new RecommendationError("RECOMMENDATION_INPUT_INVALID");
  }
}
function nullableText(value: unknown): string | null {
  if (value === null) return null;
  return persistenceText(value);
}
function replacementId(row: Readonly<Record<string, unknown>>, source: EnvelopeSummary,
  replacements: ReadonlyMap<string, RecommendationIdentity>): string | null {
  const direct = nullableText(row["replacement_recommendation_id"]);
  const replacement = direct === null ? undefined : replacements.get(direct);
  return validateStoredTransition({
    source: source.identity,
    base_evidence_digest: row["base_evidence_digest"],
    rank: row["rank"],
    state: row["state"],
    event_evidence_digest: row["event_evidence_digest"],
    transition_occurred_at: row["transition_occurred_at"],
    transition_digest: row["transition_digest"],
    replacement_recommendation_id: direct,
    replacement: replacement === undefined ? null : {
      identity: replacement,
      context_digest: row["replacement_context_digest"],
      evidence_digest: row["replacement_evidence_digest"],
    },
  });
}

export function projectRecommendations(authority: AuthorityDb, now: string, limit = 100): RecommendationReadProjection {
  const database = authority.db;
  return database.transaction(() => readRecommendations(authority, now, limit)).deferred();
}

function readRecommendations(authority: AuthorityDb, now: string, limit: number): RecommendationReadProjection {
  const database = authority.db;
  const rows = database.prepare(
    `WITH source_actions AS (
       SELECT r.recommendation_id,r.context_id,r.context_digest,r.canonical_digest,r.evidence_digest,
              r.evidence_digest AS base_evidence_digest,r.approval_requirement,r.confidence_class,r.expires_at,
              r.canonical_envelope_json,c.expires_at AS context_expires_at,c.fresh_until AS context_fresh_until,
              c.created_at AS context_created_at,c.observed_at AS context_observed_at,c.valid_at AS context_valid_at,
              a.rank,a.title,a.operation,a.target_digest,
              (SELECT state FROM personal_recommendation_action_events e WHERE e.recommendation_id=a.recommendation_id
               AND e.rank=a.rank ORDER BY event_sequence DESC LIMIT 1) AS state,
              (SELECT evidence_digest FROM personal_recommendation_action_events e WHERE e.recommendation_id=a.recommendation_id
               AND e.rank=a.rank ORDER BY event_sequence DESC LIMIT 1) AS event_evidence_digest,
              (SELECT transition_occurred_at FROM personal_recommendation_action_events e
               WHERE e.recommendation_id=a.recommendation_id AND e.rank=a.rank ORDER BY event_sequence DESC LIMIT 1) AS transition_occurred_at,
              (SELECT occurred_at FROM personal_recommendation_action_events e WHERE e.recommendation_id=a.recommendation_id
               AND e.rank=a.rank ORDER BY event_sequence DESC LIMIT 1) AS recorded_at,
              (SELECT transition_digest FROM personal_recommendation_action_events e WHERE e.recommendation_id=a.recommendation_id
               AND e.rank=a.rank ORDER BY event_sequence DESC LIMIT 1) AS transition_digest,
              (SELECT replacement_recommendation_id FROM personal_recommendation_action_events e
               WHERE e.recommendation_id=a.recommendation_id AND e.rank=a.rank ORDER BY event_sequence DESC LIMIT 1) AS replacement_recommendation_id
       FROM personal_recommendations r JOIN personal_context_snapshots c ON c.context_id=r.context_id
       JOIN personal_recommendation_actions a ON a.recommendation_id=r.recommendation_id
       WHERE NOT EXISTS (
         SELECT 1 FROM memory_projection_suppressions s
         WHERE s.projection_id=r.recommendation_id
           AND (s.projection_kind='recommendation'
             OR (s.projection_kind='recommendation_action' AND s.component_id=CAST(a.rank AS TEXT)))
       ) AND NOT EXISTS (
         SELECT 1 FROM memory_projection_quarantine q
         WHERE q.projection_id=r.recommendation_id
           AND (q.projection_kind='recommendation'
             OR (q.projection_kind='recommendation_action' AND q.component_id=CAST(a.rank AS TEXT)))
       )
       ORDER BY r.created_at DESC,r.recommendation_id,a.rank LIMIT ?)
     SELECT s.*,rr.context_digest AS replacement_context_digest,rr.canonical_digest AS replacement_canonical_digest,
            rr.evidence_digest AS replacement_evidence_digest,rr.canonical_envelope_json AS replacement_envelope_json
     FROM source_actions s LEFT JOIN personal_recommendations rr
       ON rr.recommendation_id=s.replacement_recommendation_id
     ORDER BY s.recommendation_id,s.rank`,
  ).all(limit).map(persistenceRow);
  const summaries = new Map<string, EnvelopeSummary>();
  const replacements = new Map<string, RecommendationIdentity>();
  for (const row of rows) {
    const id = persistenceText(row["recommendation_id"]);
    if (!summaries.has(id)) {
      const details = summary(row["canonical_digest"], row["evidence_digest"], row["canonical_envelope_json"]);
      validateStoredRecommendationEvents(database, details.identity, row["evidence_digest"], id);
      summaries.set(id, details);
    }
    const replacement = nullableText(row["replacement_recommendation_id"]);
    if (replacement !== null && !replacements.has(replacement)) {
      replacements.set(replacement, storedRecommendationIdentity(row["replacement_canonical_digest"],
        row["replacement_evidence_digest"], row["replacement_envelope_json"]));
    }
  }
  const contextIds = [...new Set(rows.map(row => persistenceText(row["context_id"])))];
  const unavailableContexts = contextsWithUnavailableLocalSource(database, contextIds, now);
  // A task the owner hid takes its derived memory out of current work as well: the recommendation
  // stays on record, and stops being offered.
  const closedMemoryContexts = contextsWithClosedMemorySource(authority, contextIds);
  const actions = rows.map(row => {
    const state = lifecycle(row["state"]); const rank = Number(row["rank"]); const id = persistenceText(row["recommendation_id"]);
    const details = summaries.get(id); if (details === undefined) throw new RecommendationError("RECOMMENDATION_INPUT_INVALID");
    const deadline = [persistenceText(row["expires_at"]), persistenceText(row["context_expires_at"]),
      persistenceText(row["context_fresh_until"]), details.identity.recommendation.freshness.fresh_until].sort()[0];
    if (deadline === undefined) throw new RecommendationError("RECOMMENDATION_INPUT_INVALID");
    const approval = persistenceText(row["approval_requirement"]); const confidence = persistenceText(row["confidence_class"]);
    const occurredAt = nullableText(row["transition_occurred_at"]) ?? persistenceText(row["recorded_at"]);
    const recommendation = details.identity.recommendation;
    const started = [recommendation.created_at, recommendation.observed_at, recommendation.valid_at,
      recommendation.freshness.checked_at, persistenceText(row["context_created_at"]),
      persistenceText(row["context_observed_at"]), persistenceText(row["context_valid_at"]),
      occurredAt, persistenceText(row["recorded_at"])].every(timestamp => timestamp <= now);
    const current = (state === "pending" || state === "accepted") && started && now < deadline
      && !unavailableContexts.has(persistenceText(row["context_id"]))
      && !closedMemoryContexts.has(persistenceText(row["context_id"]));
    return {
      recommendation_id: id, context_id: persistenceText(row["context_id"]), context_digest: persistenceText(row["context_digest"]),
      canonical_digest: persistenceText(row["canonical_digest"]), context_evidence_digest: persistenceText(row["evidence_digest"]),
      evidence_digest: persistenceText(row["evidence_digest"]), identity_digest: details.identity.identity_digest,
      provenance_digest: details.identity.provenance_digest, evidence_links: details.linksByRank.get(rank) ?? [], rank,
      title: persistenceText(row["title"]), operation: persistenceText(row["operation"]), target_digest: persistenceText(row["target_digest"]),
      approval_requirement: approval === "owner" ? "owner" as const : "none" as const,
      confidence_class: confidence === "high" ? "high" as const : confidence === "medium" ? "medium" as const : "low" as const,
      owner_decision_required: details.ownerRanks.has(rank), state,
      replacement_recommendation_id: replacementId(row, details, replacements), occurred_at: occurredAt,
      recorded_at: persistenceText(row["recorded_at"]), transition_digest: nullableText(row["transition_digest"]),
      current, executable: false as const, expires_at: deadline,
    };
  });
  const current = actions.filter(action => action.current).sort((left, right) => left.rank - right.rank
    || left.recommendation_id.localeCompare(right.recommendation_id));
  const warnings = [...new Map(rows.flatMap(row => {
    const id = persistenceText(row["recommendation_id"]); const details = summaries.get(id);
    if (details === undefined) throw new RecommendationError("RECOMMENDATION_INPUT_INVALID");
    const expires = [persistenceText(row["expires_at"]), persistenceText(row["context_expires_at"]),
      details.identity.recommendation.freshness.fresh_until].sort()[0];
    const fresh = persistenceText(row["context_fresh_until"]);
    const warning = now >= (expires ?? fresh)
      ? { recommendation_id: id, code: "RECOMMENDATION_EXPIRED" as const, deadline: expires ?? fresh }
      : now >= fresh ? { recommendation_id: id, code: "RECOMMENDATION_STALE" as const, deadline: fresh } : undefined;
    const source = unavailableContexts.has(persistenceText(row["context_id"]))
      ? { recommendation_id: id, code: "RECOMMENDATION_SOURCE_UNAVAILABLE" as const, deadline: expires ?? fresh }
      : undefined;
    const closed = closedMemoryContexts.has(persistenceText(row["context_id"]))
      ? { recommendation_id: id, code: "RECOMMENDATION_MEMORY_SOURCE_CLOSED" as const, deadline: expires ?? fresh }
      : undefined;
    return [warning, source, closed].flatMap(item => item === undefined ? [] : [[`${id}:${item.code}`, item] as const]);
  })).values()].sort((left, right) => left.deadline.localeCompare(right.deadline)
    || left.recommendation_id.localeCompare(right.recommendation_id));
  return { generated_at: now, next_actions: current,
    lifecycle_actions: [...actions].sort((left, right) => left.recommendation_id.localeCompare(right.recommendation_id) || left.rank - right.rank),
    owner_decisions_needed: current.filter(action => action.owner_decision_required && action.state === "pending"),
    conflicts: [...new Set([...summaries.values()].flatMap(item => item.conflicts))].sort(),
    omissions: [...new Set([...summaries.values()].flatMap(item => item.omissions))].sort(), warnings };
}
