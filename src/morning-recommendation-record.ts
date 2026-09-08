import type { ContextSnapshotV1 } from "./personal-contracts.js";
import { persistenceHash } from "./personal-persistence-values.js";
import type { RecommendationIdentity } from "./recommendation-identity.js";
import type { PriorityActionDecision, PriorityDeadline } from "./priority-engine-contracts.js";
import { classifyPriorityDeadline } from "./priority-engine-ranking.js";
import type { MorningBriefRecord } from "./morning-brief-types.js";
import { invalidMorningSource } from "./morning-recommendation-context.js";

export function morningRecommendationRecord(identity: RecommendationIdentity, context: ContextSnapshotV1,
  decision: PriorityActionDecision, state: string, deadline: PriorityDeadline | null, now: string): MorningBriefRecord {
  const recommendation = identity.recommendation;
  const material = identity.provenance.actions.find(item => item.action_id === decision.action_id);
  const fields = decision.rationale.lexicographic_fields;
  if (material === undefined || fields.stable_identity === null) return invalidMorningSource();
  const refs = new Set(Object.values(decision.rationale.citations).filter(value => value !== null));
  const links = identity.provenance.linux_evidence.filter(link => refs.has(link.ref));
  const citations = links.map(link => {
    const evidence = context.evidence.find(item => item.evidence_id === link.context_evidence_id);
    if (evidence === undefined && link.kind !== "policy") return invalidMorningSource();
    if (evidence !== undefined && evidence.digest !== link.digest) return invalidMorningSource();
    const sourceId = evidence?.source_id ?? context.source.source_id;
    return { link_id: `brief-link:${persistenceHash({ ref: link.ref, source_id: sourceId, digest: link.digest }).slice(7)}`,
      source_id: sourceId, evidence_ref: link.ref };
  });
  const itemId = `brief-input:${persistenceHash({ recommendation_id: recommendation.id, rank: decision.rank }).slice(7)}`;
  const actionId = `brief-action:${persistenceHash({ recommendation_id: recommendation.id, action_id: decision.action_id }).slice(7)}`;
  const observedAt = [recommendation.observed_at, context.observed_at, deadline?.observed_at ?? context.observed_at].sort().at(-1)!;
  const validFrom = [recommendation.valid_at, context.valid_at].sort().at(-1)!;
  const validUntil = [recommendation.expires_at, context.expires_at].sort()[0]!;
  const freshUntil = [recommendation.freshness.fresh_until, context.freshness.fresh_until,
    deadline?.fresh_until ?? recommendation.freshness.fresh_until].sort()[0]!;
  const core = {
    item_id: itemId, recommendation_id: recommendation.id, action_id: actionId,
    semantic_key: `recommendation-operation:${persistenceHash({ operation: material.operation, target_digest: material.target_digest }).slice(7)}`,
    kind: "action" as const, state: "actionable" as const, copy: material.title,
    source_ids: [...new Set(citations.map(link => link.source_id))].sort(), citations,
    observed_at: observedAt, valid_from: validFrom, valid_until: validUntil, fresh_until: freshUntil,
    // A recorded recommendation is advisory even when the user accepted the action.
    trust: "inferred" as const, confidence: identity.provenance.confidence_class,
    owner_decision_required: state === "pending" && decision.disposition === "owner_gate_required",
    deadline: deadline?.due_at ?? null,
    priority: { ...fields, stable_identity: fields.stable_identity, deadline_bucket: classifyPriorityDeadline(deadline, now) },
  };
  const provenance = { item_id: itemId, recommendation_id: recommendation.id, action_id: actionId,
    source_ids: core.source_ids, citations, observed_at: observedAt, valid_from: core.valid_from,
    valid_until: validUntil, fresh_until: freshUntil };
  return { ...core, canonical_digest: persistenceHash(core), provenance_digest: persistenceHash(provenance) };
}
