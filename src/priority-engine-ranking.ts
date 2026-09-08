import { canonicalize } from "./canonical.js";
import { kstLocalDate } from "./daily-loop-time.js";
import {
  PRIORITY_LEXICOGRAPHIC_ORDER,
  PRIORITY_LEXICOGRAPHIC_POLICY,
  type PriorityActionDecision,
  type PriorityCandidateAction,
  type PriorityCitations,
  type PriorityDeadline,
  type PriorityDeadlineBucket,
  type PriorityLexicographicField,
  type PriorityLexicographicFields,
  type PriorityReasonCode,
} from "./priority-engine-contracts.js";
import {
  orderedPriorityReasons,
  type PriorityEvidenceEvaluation,
} from "./priority-engine-evidence.js";

export type PriorityCandidateRanking = {
  readonly status: "ranked" | "abstained";
  readonly reasons: readonly PriorityReasonCode[];
  readonly actions: readonly PriorityActionDecision[];
};
type PreparedAction = {
  readonly candidate: PriorityCandidateAction;
  readonly fields: PriorityLexicographicFields;
  readonly citations: PriorityCitations;
  readonly disposition: "executable" | "delegated" | "owner_gate_required" | "excluded" | "abstained";
  readonly reasons: readonly PriorityReasonCode[];
};
type DecisionPlacement = {
  readonly rank: number | null;
  readonly decisive: PriorityLexicographicField | "only_action" | null;
  readonly tied: boolean;
};

const compareText = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;
export function classifyPriorityDeadline(deadline: PriorityDeadline | null, clock: string): PriorityDeadlineBucket {
  if (deadline === null) return "none";
  const due = Date.parse(deadline.due_at);
  const now = Date.parse(clock);
  if (due < now) return "overdue";
  if (kstLocalDate(new Date(due)) === kstLocalDate(new Date(now))) return "today";
  if (due <= now + 7 * 86_400_000) return "within_seven_days";
  return "later";
}
function lexicographicFields(candidate: PriorityCandidateAction, clock: string): PriorityLexicographicFields {
  return {
    owner_safety_gate: candidate.owner_safety_gate,
    customer_impact: candidate.customer_impact,
    deadline_bucket: classifyPriorityDeadline(candidate.deadline, clock),
    dependency_blocking: candidate.dependency.kind,
    irreversible_risk: candidate.irreversible_risk,
    effort_cost: candidate.effort_cost,
    stable_identity: candidate.stable_identity?.key ?? null,
  };
}
function selectedLinuxFact(reference: string | null, evaluation: PriorityEvidenceEvaluation): boolean {
  if (reference === null || !evaluation.decision.selected_refs.includes(reference)) return false;
  return evaluation.input.context_policy_input.evidence.some(item => item.kind === "evidence"
    && item.ref === reference && item.evidence_class === "linux_live_fact" && item.source_host === "linux-control-plane");
}
function actionCitations(candidate: PriorityCandidateAction, evaluation: PriorityEvidenceEvaluation): PriorityCitations {
  const principle = evaluation.principle;
  const stableIdentityRef = candidate.stable_identity?.evidence_ref ?? null;
  return {
    confirmed_principle_ref: principle?.principle_ref ?? null,
    confirmed_principle_evidence_ref: principle?.evidence_ref ?? null,
    linux_policy_decision_ref: evaluation.policyDecisionRef,
    owner_import_decision_ref: principle?.import_gate.decision_ref ?? null,
    current_linux_evidence_ref: selectedLinuxFact(candidate.current_evidence_ref, evaluation) ? candidate.current_evidence_ref : null,
    deadline_evidence_ref: candidate.deadline === null
      ? null
      : selectedLinuxFact(candidate.deadline.evidence_ref, evaluation) ? candidate.deadline.evidence_ref : null,
    dependency_evidence_ref: candidate.dependency.kind === "non_blocking"
      ? null
      : selectedLinuxFact(candidate.dependency.evidence_ref, evaluation) ? candidate.dependency.evidence_ref : null,
    owner_gate_ref: candidate.owner_gate_ref,
    stable_identity_evidence_ref: selectedLinuxFact(stableIdentityRef, evaluation) ? stableIdentityRef : null,
  };
}
function prepareCandidate(candidate: PriorityCandidateAction, evaluation: PriorityEvidenceEvaluation): PreparedAction {
  const fields = lexicographicFields(candidate, evaluation.input.clock);
  const citations = actionCitations(candidate, evaluation);
  if (candidate.owner_safety_gate === "safety_blocked") {
    return { candidate, fields, citations, disposition: "excluded", reasons: ["PRIORITY_SAFETY_BLOCKED"] };
  }
  const reasons = new Set<PriorityReasonCode>();
  if (evaluation.principle === null || candidate.principle_ref !== evaluation.principle.principle_ref
    || citations.confirmed_principle_evidence_ref === null || citations.linux_policy_decision_ref === null
    || citations.owner_import_decision_ref === null || citations.current_linux_evidence_ref === null
    || (candidate.deadline !== null && citations.deadline_evidence_ref === null)
    || (candidate.dependency.kind !== "non_blocking" && citations.dependency_evidence_ref === null)
    || (candidate.owner_safety_gate === "owner_approval_required" && candidate.owner_gate_ref === null)) {
    reasons.add("PRIORITY_REQUIRED_CITATION_MISSING");
  }
  if (candidate.deadline !== null && Date.parse(candidate.deadline.fresh_until) <= Date.parse(evaluation.input.clock)) {
    reasons.add("PRIORITY_STALE_DEADLINE");
  }
  if (reasons.size > 0) {
    return { candidate, fields, citations, disposition: "abstained", reasons: orderedPriorityReasons(reasons) };
  }
  if (candidate.owner_safety_gate === "owner_approval_required") {
    return { candidate, fields, citations, disposition: "owner_gate_required", reasons: ["PRIORITY_OWNER_APPROVAL_REQUIRED"] };
  }
  return candidate.execution_mode === "delegated"
    ? { candidate, fields, citations, disposition: "delegated", reasons: ["PRIORITY_DELEGATED"] }
    : { candidate, fields, citations, disposition: "executable", reasons: ["PRIORITY_EXECUTABLE"] };
}
function compareOrdinal(left: string, right: string, order: readonly string[]): number {
  return order.indexOf(left) - order.indexOf(right);
}
function comparePrepared(left: PreparedAction, right: PreparedAction): number {
  const comparisons = [
    compareOrdinal(left.fields.owner_safety_gate, right.fields.owner_safety_gate, PRIORITY_LEXICOGRAPHIC_POLICY.owner_safety_gate),
    compareOrdinal(left.fields.customer_impact, right.fields.customer_impact, PRIORITY_LEXICOGRAPHIC_POLICY.customer_impact),
    compareOrdinal(left.fields.deadline_bucket, right.fields.deadline_bucket, PRIORITY_LEXICOGRAPHIC_POLICY.deadline_bucket),
    compareOrdinal(left.fields.dependency_blocking, right.fields.dependency_blocking, PRIORITY_LEXICOGRAPHIC_POLICY.dependency_blocking),
    compareOrdinal(left.fields.irreversible_risk, right.fields.irreversible_risk, PRIORITY_LEXICOGRAPHIC_POLICY.irreversible_risk),
    compareOrdinal(left.fields.effort_cost, right.fields.effort_cost, PRIORITY_LEXICOGRAPHIC_POLICY.effort_cost),
  ];
  const decisive = comparisons.find(value => value !== 0);
  return decisive ?? compareText(left.fields.stable_identity ?? "", right.fields.stable_identity ?? "");
}
function tieKey(value: PreparedAction): string {
  return canonicalize({
    owner_safety_gate: value.fields.owner_safety_gate,
    customer_impact: value.fields.customer_impact,
    deadline_bucket: value.fields.deadline_bucket,
    dependency_blocking: value.fields.dependency_blocking,
    irreversible_risk: value.fields.irreversible_risk,
    effort_cost: value.fields.effort_cost,
  });
}
function unresolvedTieIds(values: readonly PreparedAction[]): ReadonlySet<string> {
  const groups = new Map<string, PreparedAction[]>();
  for (const value of values) {
    const key = tieKey(value);
    const group = groups.get(key) ?? [];
    group.push(value);
    groups.set(key, group);
  }
  const tied = new Set<string>();
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const identities = group.map(item => item.candidate.stable_identity);
    const keys = identities.flatMap(item => item === null ? [] : [item.key]);
    const sufficient = identities.every(item => item !== null)
      && group.every(item => item.citations.stable_identity_evidence_ref !== null)
      && keys.length === group.length && new Set(keys).size === group.length;
    if (!sufficient) for (const item of group) tied.add(item.candidate.action_id);
  }
  return tied;
}
function decisiveField(values: readonly PreparedAction[], index: number): PriorityLexicographicField | "only_action" {
  if (values.length === 1) return "only_action";
  const current = values[index];
  const peer = values[index + 1] ?? values[index - 1];
  if (current === undefined || peer === undefined) return "only_action";
  return PRIORITY_LEXICOGRAPHIC_ORDER.find(field => current.fields[field] !== peer.fields[field]) ?? "stable_identity";
}
function actionDecision(value: PreparedAction, placement: DecisionPlacement): PriorityActionDecision {
  const reasons: readonly PriorityReasonCode[] = placement.tied
    ? ["PRIORITY_EXACT_TIE_INSUFFICIENT_EVIDENCE"]
    : value.reasons;
  return {
    action_id: value.candidate.action_id,
    rank: placement.rank,
    disposition: placement.tied ? "abstained" : value.disposition,
    authority: "none",
    reason_codes: reasons,
    rationale: { decisive_field: placement.decisive, lexicographic_fields: value.fields, citations: value.citations },
  };
}

export function rankPriorityCandidates(evaluation: PriorityEvidenceEvaluation): PriorityCandidateRanking {
  const prepared = evaluation.input.candidates.map(candidate => prepareCandidate(candidate, evaluation));
  const globallyAbstained = evaluation.reasons.length > 0;
  const eligible = prepared.filter(item => item.disposition !== "excluded" && item.disposition !== "abstained");
  const ties = unresolvedTieIds(eligible);
  const ranked = globallyAbstained
    ? []
    : eligible.filter(item => !ties.has(item.candidate.action_id)).sort(comparePrepared);
  const rankedIds = new Set(ranked.map(item => item.candidate.action_id));
  const rankedActions = ranked.map((item, index) => actionDecision(item, {
    rank: index + 1, decisive: decisiveField(ranked, index), tied: false,
  }));
  const unrankedActions = prepared
    .filter(item => !rankedIds.has(item.candidate.action_id))
    .sort((left, right) => compareText(left.candidate.action_id, right.candidate.action_id))
    .map(item => globallyAbstained
      ? actionDecision(
          {
            ...item,
            disposition: "abstained",
            reasons: ties.has(item.candidate.action_id)
              ? orderedPriorityReasons([...evaluation.reasons, "PRIORITY_EXACT_TIE_INSUFFICIENT_EVIDENCE"])
              : evaluation.reasons,
          },
          { rank: null, decisive: null, tied: false },
        )
      : actionDecision(item, { rank: null, decisive: null, tied: ties.has(item.candidate.action_id) }));
  const actions = [...rankedActions, ...unrankedActions];
  const reasons = new Set<PriorityReasonCode>(evaluation.reasons);
  if (rankedActions.length > 0) reasons.add("PRIORITY_RANKED");
  for (const action of actions) for (const reason of action.reason_codes) reasons.add(reason);
  return {
    status: rankedActions.length > 0 ? "ranked" : "abstained",
    reasons: orderedPriorityReasons(reasons),
    actions,
  };
}
