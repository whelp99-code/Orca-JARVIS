import type { AuthorityDb } from "./db.js";
import { assemblePersonalContext } from "./context-assembler.js";
import type { ContextAssemblerInput, MemoryInput } from "./context-assembler-input.js";
import { CANONICAL_GATES } from "./personal-os-policy-contract.js";
import { citationAuthorityForContext, type AssembledCitation } from "./personal-context-citation-contract.js";
import { ownerConfirmedContent } from "./personal-memory-reference-evidence.js";
import type { ContextSnapshotV1 } from "./personal-contracts.js";
import type { ContextMemoryEvidenceBinding, StoredContext } from "./personal-context-types.js";
import { canonicalPersonalContractHash } from "./personal-validation.js";
import type { PriorityActionDecision, PriorityEngineResultV2, PriorityReasonCode } from "./priority-engine-contracts.js";
import { rankPriorityActionsWithDeadlineEvidence } from "./priority-engine.js";
import { approvedOwnerDecisionDigest, recommendationEvidenceLinks } from "./recommendation-evidence-binding.js";
import { Recommendations, type CreateRecommendationResult } from "./recommendations.js";

export type DailyRecommendationRequest = {
  readonly assemble: ContextAssemblerInput;
  /** The personal OS policy the priority engine reads. */
  readonly policy: unknown;
  readonly policy_decision_ref: string;
  /** Which confirmed principle the proposed actions rest on. */
  readonly principle_ref: string;
  /** The control request that admitted that principle; an owner decision lives in the control plane. */
  readonly owner_import_decision_ref: string;
  readonly candidates: readonly Record<string, unknown>[];
  readonly recommendation: {
    readonly id: string;
    readonly idempotency_key: string;
    readonly correlation_id: string;
    readonly causation_id: string | null;
    readonly expires_at: string;
    readonly confidence_class: "low" | "medium" | "high";
    readonly actions: readonly { readonly action_id: string; readonly title: string;
      readonly operation: string; readonly target_digest: string }[];
  };
};

export type DailyRecommendationProduction =
  | { readonly state: "abstained"; readonly context: ContextSnapshotV1; readonly stored: StoredContext;
      readonly ranking: PriorityEngineResultV2; readonly reasons: readonly PriorityReasonCode[] }
  | { readonly state: "recommended"; readonly context: ContextSnapshotV1; readonly stored: StoredContext;
      readonly ranking: PriorityEngineResultV2; readonly created: CreateRecommendationResult };

/** The memory bindings the context actually kept, so persistence and assembly cannot disagree. */
function memoryBindings(context: ContextSnapshotV1,
  memories: readonly MemoryInput[]): readonly ContextMemoryEvidenceBinding[] {
  const included = new Set(context.payload.included_memory_refs);
  return memories.flatMap(memory => {
    if (memory.kind !== "evidence" || !included.has(memory.memory_ref)) return [];
    const evidence = context.evidence.find(item => item.kind === "confirmed_memory"
      && item.digest === memory.digest && item.source_id === memory.source_id);
    return evidence === undefined ? [] : [{ memory_ref: memory.memory_ref, evidence_id: evidence.evidence_id,
      source_id: memory.source_id, digest: memory.digest, observed_at: memory.observed_at,
      fresh_until: memory.fresh_until }];
  });
}

/**
 * Whether the gate this action would cross is one the owner really decided.
 *
 * The engine ranks an owner-gated action as needing approval, which is its own correct answer: the
 * gate is a pointer, not a proof. The proof lives here, and the binding boundary already refuses a
 * link to an approval that is not on record - by throwing, after this function's caller has written
 * the assembled context. So the question is asked before anything is created, and an action whose
 * gate the owner never decided is simply not selected.
 */
function ownerGateDecided(authority: AuthorityDb, action: PriorityActionDecision): boolean {
  const reference = action.rationale.citations.owner_gate_ref;
  return reference === null || approvedOwnerDecisionDigest(authority.db, reference) !== undefined;
}

function ownerGateReferences(candidates: readonly Record<string, unknown>[]): readonly string[] {
  return candidates.flatMap(candidate => {
    const reference = candidate["owner_gate_ref"];
    return typeof reference === "string" && reference.length > 0 ? [reference] : [];
  });
}

/**
 * The policy input, derived rather than declared.
 *
 * Every fact here is one the stored context can already prove: the citation authority decided which
 * references may be cited and as what, from each piece's own source. Owner decisions are not in that
 * set and never can be - an owner decision is an authority receipt - so each one is admitted only
 * when the control plane holds an approved, unrevoked, owner-signed receipt for it.
 *
 * The policy vocabulary carries a single trusted level and it is spelled `user_confirmed`. A
 * verified live adapter fact and a confirmed principle both sit there; the class and the host still
 * have to match, so nothing is granted an authority its source did not give it.
 */
function policyFacts(authority: AuthorityDb, request: DailyRecommendationRequest,
  context: ContextSnapshotV1, citable: readonly AssembledCitation[]): readonly Record<string, unknown>[] {
  const observedOf = (evidenceId: string): string =>
    context.evidence.find(item => item.evidence_id === evidenceId)?.observed_at ?? context.observed_at;
  const assembled = citable.map(item => ({
    kind: "evidence", ref: item.reference, evidence_class: item.citation_kind,
    source_host: item.citation_kind === "user_confirmed_principle" ? "linux-second-brain" : "linux-control-plane",
    state: "current", trust: "user_confirmed", relation: "supports",
    relates_to: item.citation_kind === "linux_live_fact" ? null : request.principle_ref,
    observed_at: observedOf(item.evidence_id), valid_from: observedOf(item.evidence_id),
    valid_until: context.expires_at, fresh_until: context.freshness.fresh_until,
  }));
  const ownerReferences = [...new Set([request.owner_import_decision_ref,
    ...ownerGateReferences(request.candidates)])];
  const owner = ownerReferences.flatMap(reference =>
    approvedOwnerDecisionDigest(authority.db, reference) === undefined ? [] : [{
      kind: "evidence", ref: reference, evidence_class: "owner_decision",
      source_host: "linux-control-plane", state: "current", trust: "user_confirmed",
      relation: "supports", relates_to: request.principle_ref,
      observed_at: context.observed_at, valid_from: context.observed_at,
      valid_until: context.expires_at, fresh_until: context.freshness.fresh_until,
    }]);
  return [...assembled, ...owner];
}

/**
 * The principle the proposed work rests on, or the engine's own way of saying it is not there.
 *
 * A principle that cannot be cited is reported as a gap rather than left out: the engine has a
 * vocabulary for an unavailable principle and abstains on it, while an empty list is not an input
 * it can read at all. A memory whose task the owner closed arrives here as exactly that gap.
 */
function principleSources(authority: AuthorityDb, request: DailyRecommendationRequest,
  context: ContextSnapshotV1, citable: readonly AssembledCitation[]): readonly Record<string, unknown>[] {
  const declared = request.assemble.memories.find(item => item.kind === "evidence"
    && item.memory_ref === request.principle_ref);
  const gap = [{ kind: "gap", principle_ref: request.principle_ref,
    source_id: declared !== undefined && declared.kind === "evidence"
      ? declared.source_id : "src:pos:v1:second-brain:primary",
    source_host: "linux-second-brain", state: "unavailable", checked_at: request.assemble.clock }];
  const principle = citable.find(item => item.reference === request.principle_ref
    && item.citation_kind === "user_confirmed_principle");
  if (principle === undefined) return gap;
  const evidence = context.evidence.find(item => item.evidence_id === principle.evidence_id);
  if (evidence === undefined) return gap;
  const approved = approvedOwnerDecisionDigest(authority.db, request.owner_import_decision_ref) !== undefined;
  return [{
    kind: "evidence", principle_ref: principle.reference, evidence_ref: principle.reference,
    source_id: evidence.source_id, source_host: "linux-second-brain",
    content_digest: evidence.digest, trust: "user_confirmed",
    observed_at: evidence.observed_at, fresh_until: context.freshness.fresh_until,
    import_gate: { gate_id: CANONICAL_GATES.mac_vault_transfer,
      state: approved ? "approved" : "required",
      decision_ref: approved ? request.owner_import_decision_ref : null,
      decision_host: "linux-control-plane" },
  }];
}

/**
 * The production chain: assemble a context from real sources, persist it, rank the proposed work
 * against what that stored context can prove, and record a recommendation when an action survives.
 *
 * An abstention is a result, not a failure. Evidence that only says what a local cache held cannot
 * support a current Linux fact, so the ranking withholds the action and nothing is written beyond
 * the context itself - which is exactly what the daily brief then reports.
 */
export function produceDailyRecommendation(authority: AuthorityDb,
  request: DailyRecommendationRequest): DailyRecommendationProduction {
  const context = assemblePersonalContext(request.assemble);
  const stored = authority.persistContextSnapshot(
    { context, memory_evidence: memoryBindings(context, request.assemble.memories) }, request.assemble.clock);
  // What the stored context licenses, minus any principle this database cannot show the owner
  // confirmed. Assembly seals a memory as a confirmed principle because the request said its trust
  // was user_confirmed - it has nothing else to go on - so a run that produces from those inputs has
  // to ask the control plane before resting an action on one. A principle that fails here is simply
  // not cited, and the engine abstains for want of one.
  const licensed = citationAuthorityForContext(authority, context.id);
  const confirmedPrinciple = (item: AssembledCitation): boolean => {
    if (item.citation_kind !== "user_confirmed_principle") return true;
    const evidence = context.evidence.find(entry => entry.evidence_id === item.evidence_id);
    return evidence !== undefined && ownerConfirmedContent(authority, evidence.digest);
  };
  const citations = { citable: licensed.citable.filter(confirmedPrinciple),
    uncitable: licensed.uncitable };
  const ranking = rankPriorityActionsWithDeadlineEvidence(request.policy, {
    schema_version: 1, clock: request.assemble.clock,
    linux_policy_decision_ref: request.policy_decision_ref,
    context_policy_input: { schema_version: 1, clock: request.assemble.clock,
      required_evidence: ["linux_live_fact", "user_confirmed_principle", "owner_decision"],
      evidence: policyFacts(authority, request, context, citations.citable) },
    principles: principleSources(authority, request, context, citations.citable),
    candidates: request.candidates,
    presentation: { model_disagrees: false, model_preferred_action_ids: [], mac_evidence_refs: [] },
  });
  const selected = ranking.actions.filter(action => action.rank !== null && ownerGateDecided(authority, action));
  if (selected.length === 0) {
    return { state: "abstained", context, stored, ranking,
      reasons: [...new Set(ranking.actions.flatMap(action => action.reason_codes))].sort() };
  }
  const contextDigest = canonicalPersonalContractHash(context);
  const created = new Recommendations(authority).create({
    id: request.recommendation.id, idempotency_key: request.recommendation.idempotency_key,
    correlation_id: request.recommendation.correlation_id, causation_id: request.recommendation.causation_id,
    context_id: context.id, context_digest: contextDigest,
    expires_at: request.recommendation.expires_at, ranking,
    actions: request.recommendation.actions,
    linux_evidence: recommendationEvidenceLinks({ authority, contextId: context.id,
      contextDigest, result: ranking, actions: selected }),
    approval_requirement: selected.some(action => action.disposition === "owner_gate_required") ? "owner" : "none",
    confidence_class: request.recommendation.confidence_class,
  });
  return { state: "recommended", context, stored, ranking, created };
}
