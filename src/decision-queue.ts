import { createHash } from "node:crypto";
import { canonicalize } from "./canonical.js";
import { PRIORITY_LEXICOGRAPHIC_POLICY } from "./priority-engine-contracts.js";
import type { DecisionOmissionReason, DecisionQueueInput, DecisionQueueProjection, DecisionQueueRecord,
  DecisionQueueState, OwnerDecisionQueueEntry } from "./notification-intent-types.js";

const hash = (value: unknown): string => createHash("sha256").update(canonicalize(value)).digest("hex");
const compareText = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;
const ordinal = (left: string, right: string, order: readonly string[]): number => order.indexOf(left) - order.indexOf(right);
type QueueOrder = Pick<DecisionQueueRecord, "priority" | "deadline" | "semantic_key" | "recommendation_id">;
function compareOrder(left: QueueOrder, right: QueueOrder): number {
  const comparisons = [
    ordinal(left.priority.owner_safety_gate, right.priority.owner_safety_gate, PRIORITY_LEXICOGRAPHIC_POLICY.owner_safety_gate),
    ordinal(left.priority.customer_impact, right.priority.customer_impact, PRIORITY_LEXICOGRAPHIC_POLICY.customer_impact),
    ordinal(left.priority.deadline_bucket, right.priority.deadline_bucket, PRIORITY_LEXICOGRAPHIC_POLICY.deadline_bucket),
    ordinal(left.priority.dependency_blocking, right.priority.dependency_blocking, PRIORITY_LEXICOGRAPHIC_POLICY.dependency_blocking),
    ordinal(left.priority.irreversible_risk, right.priority.irreversible_risk, PRIORITY_LEXICOGRAPHIC_POLICY.irreversible_risk),
    ordinal(left.priority.effort_cost, right.priority.effort_cost, PRIORITY_LEXICOGRAPHIC_POLICY.effort_cost),
    compareText(left.priority.stable_identity ?? "", right.priority.stable_identity ?? ""),
    compareText(left.deadline ?? "9999", right.deadline ?? "9999"),
  ];
  return comparisons.find(value => value !== 0) ?? (compareText(left.semantic_key, right.semantic_key)
    || compareText(left.recommendation_id, right.recommendation_id));
}
function currentState(value: DecisionQueueRecord, clock: string): DecisionQueueState {
  if (clock >= value.expires_at) return "expired";
  const latest = value.events.at(-1);
  if (latest?.state === "snoozed") return "snoozed";
  if (latest?.state === "expired") return "expired";
  if (latest?.state === "pending") return "needs_owner";
  return "resolved";
}
function omission(value: DecisionQueueRecord, clock: string): DecisionOmissionReason | null {
  if (value.source_state !== "active") return value.source_state;
  if (value.trust === "untrusted") return "untrusted";
  if (value.source_ids.length === 0 || value.citations.length === 0
    || value.source_ids.some(source => !value.citations.some(citation => citation.source_id === source))) return "uncited";
  const state = currentState(value, clock);
  if (state !== "needs_owner") return state;
  return value.citations.some(citation => clock >= citation.fresh_until) ? "stale" : null;
}
function unique(values: readonly string[]): readonly string[] { return [...new Set(values)].sort(compareText); }
function entry(values: readonly DecisionQueueRecord[], clock: string): OwnerDecisionQueueEntry {
  const sorted = [...values].sort(compareOrder); const representative = sorted[0];
  if (representative === undefined) throw new NotificationQueueInvariantError();
  const citations = [...new Map(sorted.flatMap(value => value.citations)
    .map(value => [`${value.source_id}:${value.evidence_ref}:${value.evidence_digest}`, value] as const)).values()]
    .sort((left, right) => compareText(left.source_id, right.source_id) || compareText(left.evidence_ref, right.evidence_ref));
  const contributingRecommendations = unique(sorted.map(value => value.recommendation_id));
  const contributingActions = unique(sorted.map(value => value.action_id));
  const contributingContexts = unique(sorted.map(value => value.context_id));
  const contributingEvidence = unique(sorted.map(value => value.evidence_digest));
  const contributingIdentities = unique(sorted.map(value => value.identity_digest));
  const contributingProvenance = unique(sorted.map(value => value.provenance_digest));
  const sourceIds = unique(sorted.flatMap(value => value.source_ids)); const latest = representative.events.at(-1);
  if (latest === undefined) throw new NotificationQueueInvariantError();
  const urgency = representative.safety === "critical" || (representative.deadline !== null
    && Date.parse(representative.deadline) - Date.parse(clock) <= 60 * 60_000)
    ? "critical" as const : representative.deadline === null ? "digest" as const : "action" as const;
  const semantic = {
    semantic_key: representative.semantic_key, recommendation_id: representative.recommendation_id,
    action_id: representative.action_id, context_id: representative.context_id, context_digest: representative.context_digest,
    recommendation_digest: representative.recommendation_digest, evidence_digest: representative.evidence_digest,
    identity_digest: representative.identity_digest, provenance_digest: representative.provenance_digest,
    contributing_recommendation_ids: contributingRecommendations, contributing_action_ids: contributingActions,
    contributing_context_ids: contributingContexts, contributing_evidence_digests: contributingEvidence,
    contributing_identity_digests: contributingIdentities, contributing_provenance_digests: contributingProvenance,
    source_ids: sourceIds, citations, occurred_at: latest.occurred_at, deadline: representative.deadline,
    expires_at: representative.expires_at, confidence: representative.confidence, reversible: representative.reversible,
    safety: representative.safety, priority: representative.priority,
  };
  const semanticDigest = `sha256:${hash(semantic)}`; const key = hash({ semantic_key: representative.semantic_key });
  const queueKey = `decision:v1:${key}`;
  return {
    queue_key: queueKey, dedup_key: `notification:v1:${key}`, thread_key: `decision-thread:v1:${hash({
      recommendation_id: representative.recommendation_id,
    })}`, semantic_key: representative.semantic_key, category: "owner_decision", resource_id: queueKey, urgency,
    title: "Owner decision required",
    preview: representative.safety === "critical" ? "Review a time-sensitive protected decision." : "Review a protected owner decision.",
    deep_link: `/decisions/${hash({ recommendation_id: representative.recommendation_id, action_id: representative.action_id })}`,
    recommendation_id: representative.recommendation_id, action_id: representative.action_id, context_id: representative.context_id,
    context_digest: representative.context_digest, recommendation_digest: representative.recommendation_digest,
    evidence_digest: representative.evidence_digest, identity_digest: representative.identity_digest,
    provenance_digest: representative.provenance_digest, contributing_recommendation_ids: contributingRecommendations,
    contributing_action_ids: contributingActions, contributing_context_ids: contributingContexts,
    contributing_evidence_digests: contributingEvidence, contributing_identity_digests: contributingIdentities,
    contributing_provenance_digests: contributingProvenance, source_ids: sourceIds, citations,
    created_at: representative.created_at, occurred_at: latest.occurred_at, expires_at: representative.expires_at,
    deadline: representative.deadline, confidence: representative.confidence,
    reversible: representative.reversible, safety: representative.safety, priority: representative.priority,
    state: "needs_owner", semantic_digest: semanticDigest,
  };
}
export class NotificationQueueInvariantError extends Error {
  readonly name = "NotificationQueueInvariantError";
  constructor() { super("NOTIFICATION_QUEUE_INVARIANT_FAILURE"); }
}
export function projectOwnerDecisionQueue(input: DecisionQueueInput): DecisionQueueProjection {
  const groups = new Map<string, DecisionQueueRecord[]>(); const omissions: { semantic_key: string; reason: DecisionOmissionReason }[] = [];
  for (const value of input.items) {
    const reason = omission(value, input.generated_at);
    if (reason !== null) omissions.push({ semantic_key: value.semantic_key, reason });
    else groups.set(value.semantic_key, [...(groups.get(value.semantic_key) ?? []), value]);
  }
  const active = [...groups.values()].map(values => entry(values, input.generated_at)).sort(compareOrder);
  return { generated_at: input.generated_at, active,
    omissions: omissions.sort((left, right) => compareText(left.semantic_key, right.semantic_key) || compareText(left.reason, right.reason)) };
}
