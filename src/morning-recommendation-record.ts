import type { ContextSnapshotV1 } from "./personal-contracts.js";
import { persistenceHash } from "./personal-persistence-values.js";
import type { RecommendationIdentity } from "./recommendation-identity.js";
import type { PriorityActionDecision, PriorityDeadline } from "./priority-engine-contracts.js";
import { classifyPriorityDeadline } from "./priority-engine-ranking.js";
import type { MorningBriefRecord } from "./morning-brief-types.js";
import type { RecommendationEvidenceKind } from "./recommendation-provenance.js";
import { invalidMorningSource } from "./morning-recommendation-context.js";

/**
 * Where a citation that never sat in assembled evidence comes from.
 *
 * Two of the things an action rests on are held elsewhere: the policy decision, and the owner's own
 * approval, which the control plane keeps as a signed receipt. Every other kind resolves a piece of
 * context evidence and takes its source from there, so a link of any other kind that carries no
 * evidence cannot say where it came from and is refused rather than given the context's source.
 */
const AUTHORITY_SOURCE_ID: Readonly<Partial<Record<RecommendationEvidenceKind, string>>> = {
  owner: "src:pos:v1:jarvis:control-plane",
  policy: "src:pos:v1:jarvis:personal-os-policy",
};

export function morningRecommendationRecord(identity: RecommendationIdentity, context: ContextSnapshotV1,
  decision: PriorityActionDecision, state: string, deadline: PriorityDeadline | null, now: string): MorningBriefRecord {
  const recommendation = identity.recommendation;
  const material = identity.provenance.actions.find(item => item.action_id === decision.action_id);
  const fields = decision.rationale.lexicographic_fields;
  if (material === undefined || fields.stable_identity === null) return invalidMorningSource();
  const refs = new Set(Object.values(decision.rationale.citations).filter(value => value !== null));
  const links = identity.provenance.linux_evidence.filter(link => refs.has(link.ref));
  const citations = links.map(link => {
    // A link either names a piece of context evidence or rests on authority the context never
    // held: the policy decision does, and so does the owner's approval receipt, which lives in the
    // control plane rather than in assembled evidence. A link that names evidence must resolve it
    // and match its digest; a link that names none must be of a kind that is held somewhere this
    // can name, and is cited to that place rather than to the context the assembler built.
    const evidence = link.context_evidence_id === null
      ? undefined
      : context.evidence.find(item => item.evidence_id === link.context_evidence_id);
    if (link.context_evidence_id !== null && evidence === undefined) return invalidMorningSource();
    if (evidence !== undefined && evidence.digest !== link.digest) return invalidMorningSource();
    const sourceId = evidence?.source_id ?? AUTHORITY_SOURCE_ID[link.kind];
    if (sourceId === undefined) return invalidMorningSource();
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
