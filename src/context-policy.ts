import {
  parseContextPolicyConfig,
  parseContextPolicyInput,
  type ContextFact,
  type EvidenceClass,
  type ParsedContextPolicy,
  type ParsedContextPolicyInput,
} from "./context-policy-input.js";

export const CONTEXT_POLICY_INPUT_INVALID = "CONTEXT_POLICY_INPUT_INVALID" as const;
export const CONTEXT_POLICY_CONFIG_INVALID = "CONTEXT_POLICY_CONFIG_INVALID" as const;
export type ContextPolicyErrorCode = typeof CONTEXT_POLICY_INPUT_INVALID | typeof CONTEXT_POLICY_CONFIG_INVALID;

export class ContextPolicyError extends Error {
  readonly name = "ContextPolicyError";
  constructor(readonly code: ContextPolicyErrorCode) { super(code); }
}

export const CONTEXT_POLICY_REASON_CODES = [
  "POLICY_SATISFIED", "POLICY_NOT_EFFECTIVE", "POLICY_EXPIRED", "NO_DATA", "STALE_EVIDENCE",
  "SOURCE_OFFLINE", "SOURCE_UNAVAILABLE", "SOURCE_CLOCK_SKEW", "SOURCE_HOST_MISMATCH",
  "INFERRED_EVIDENCE", "UNTRUSTED_EVIDENCE", "MAC_NON_AUTHORITATIVE", "REQUIRED_EVIDENCE_MISSING",
  "LINUX_LIVE_EVIDENCE_REQUIRED", "OWNER_DECISION_REQUIRED", "UNRESOLVED_CONFLICT", "UNRESOLVED_PRIORITY_CONFLICT",
  "SUPERSESSION_TARGET_MISSING", "SUPERSESSION_TRUST_INADEQUATE", "SUPERSESSION_VALID_TIME_CONFLICT",
] as const;
export type ContextPolicyReasonCode = (typeof CONTEXT_POLICY_REASON_CODES)[number];
export type ContextPolicyDecision = {
  readonly status: "eligible" | "abstain";
  readonly policy_id: string;
  readonly reason_codes: readonly ContextPolicyReasonCode[];
  readonly selected_refs: readonly string[];
  readonly excluded_refs: readonly string[];
  readonly conflicting_refs: readonly string[];
  readonly superseded_refs: readonly string[];
  readonly required_evidence_refs: readonly string[];
};
type DecisionState = {
  readonly reasons: Set<ContextPolicyReasonCode>;
  readonly selected: Set<string>;
  readonly excluded: Set<string>;
  readonly conflicting: Set<string>;
  readonly superseded: Set<string>;
};
type Evaluation = {
  readonly policy: ParsedContextPolicy;
  readonly input: ParsedContextPolicyInput;
  readonly facts: ReadonlyMap<string, ContextFact>;
  readonly state: DecisionState;
};

const sorted = <Value extends string>(values: ReadonlySet<Value>): readonly Value[] => [...values].sort();
function expectedHost(evidenceClass: EvidenceClass): "linux-control-plane" | "linux-second-brain" {
  switch (evidenceClass) {
    case "linux_live_fact": case "owner_decision": return "linux-control-plane";
    case "user_confirmed_principle": return "linux-second-brain";
    default: { const exhaustive: never = evidenceClass; return exhaustive; }
  }
}
function exclude(state: DecisionState, reference: string, reason: ContextPolicyReasonCode): void {
  state.excluded.add(reference); state.reasons.add(reason);
}
function conflict(state: DecisionState, references: readonly string[], reason: ContextPolicyReasonCode): void {
  for (const reference of references) state.conflicting.add(reference);
  state.reasons.add(reason);
}
function isClientHost(host: ContextFact["source_host"]): boolean {
  return host === "mac-client" || host === "phone-client";
}
function classifyFact(evaluation: Evaluation, fact: ContextFact): void {
  const { input, state } = evaluation;
  if (isClientHost(fact.source_host)) { exclude(state, fact.ref, "MAC_NON_AUTHORITATIVE"); return; }
  if (fact.source_host !== expectedHost(fact.evidence_class)) { exclude(state, fact.ref, "SOURCE_HOST_MISMATCH"); return; }
  if (fact.state === "stale" || Date.parse(fact.fresh_until) <= Date.parse(input.clock)
    || Date.parse(fact.valid_until) <= Date.parse(input.clock)) {
    const supersessionTarget = [...evaluation.facts.values()].some(
      candidate => candidate.relation === "supersedes" && candidate.relates_to === fact.ref,
    );
    if (supersessionTarget) { state.selected.add(fact.ref); return; }
    exclude(state, fact.ref, "STALE_EVIDENCE"); return;
  }
  if (Date.parse(fact.observed_at) > Date.parse(input.clock) || Date.parse(fact.valid_from) > Date.parse(input.clock)) {
    exclude(state, fact.ref, "SOURCE_CLOCK_SKEW"); return;
  }
  switch (fact.trust) {
    case "inferred":
      exclude(state, fact.ref, "INFERRED_EVIDENCE");
      if (fact.relation === "supersedes") {
        conflict(state, [fact.ref, ...(fact.relates_to === null ? [] : [fact.relates_to])], "SUPERSESSION_TRUST_INADEQUATE");
        state.reasons.add("UNRESOLVED_PRIORITY_CONFLICT");
      }
      return;
    case "untrusted":
      exclude(state, fact.ref, "UNTRUSTED_EVIDENCE");
      if (fact.relation === "supersedes") {
        conflict(state, [fact.ref, ...(fact.relates_to === null ? [] : [fact.relates_to])], "SUPERSESSION_TRUST_INADEQUATE");
        state.reasons.add("UNRESOLVED_PRIORITY_CONFLICT");
      }
      return;
    case "user_confirmed": break;
    default: { const exhaustive: never = fact.trust; return exhaustive; }
  }
  switch (fact.relation) {
    case "supports": state.selected.add(fact.ref); return;
    case "unrelated": state.excluded.add(fact.ref); return;
    case "contradicts":
      state.excluded.add(fact.ref);
      conflict(state, [fact.ref, ...(fact.relates_to === null ? [] : [fact.relates_to])], "UNRESOLVED_CONFLICT");
      return;
    case "supersedes": return;
    default: { const exhaustive: never = fact.relation; return exhaustive; }
  }
}
function applySupersession(evaluation: Evaluation, candidate: ContextFact): void {
  const { facts, state } = evaluation;
  if (state.excluded.has(candidate.ref) || candidate.relation !== "supersedes") return;
  const target = candidate.relates_to === null ? undefined : facts.get(candidate.relates_to);
  if (target === undefined) {
    exclude(state, candidate.ref, "SUPERSESSION_TARGET_MISSING");
    conflict(state, [candidate.ref], "UNRESOLVED_PRIORITY_CONFLICT");
    return;
  }
  if (target.trust !== "user_confirmed") {
    exclude(state, candidate.ref, "SUPERSESSION_TRUST_INADEQUATE");
    conflict(state, [candidate.ref, target.ref], "UNRESOLVED_PRIORITY_CONFLICT");
    return;
  }
  if (Date.parse(candidate.valid_from) < Date.parse(target.valid_until)) {
    exclude(state, candidate.ref, "SUPERSESSION_VALID_TIME_CONFLICT");
    conflict(state, [candidate.ref, target.ref], "UNRESOLVED_PRIORITY_CONFLICT");
    return;
  }
  state.selected.delete(target.ref);
  state.excluded.add(target.ref);
  state.superseded.add(target.ref);
  state.selected.add(candidate.ref);
}
function classifySources(evaluation: Evaluation): void {
  const { input, state } = evaluation;
  for (const item of [...input.evidence].sort((left, right) => left.ref.localeCompare(right.ref))) {
    switch (item.kind) {
      case "evidence": classifyFact(evaluation, item); continue;
      case "gap": break;
      default: { const exhaustive: never = item; return exhaustive; }
    }
    state.excluded.add(item.ref);
    if (isClientHost(item.source_host)) { state.reasons.add("MAC_NON_AUTHORITATIVE"); continue; }
    if (item.source_host !== expectedHost(item.evidence_class)) { state.reasons.add("SOURCE_HOST_MISMATCH"); continue; }
    if (Date.parse(item.checked_at) > Date.parse(input.clock)) { state.reasons.add("SOURCE_CLOCK_SKEW"); continue; }
    switch (item.state) {
      case "no_data": state.reasons.add("NO_DATA"); break;
      case "offline": state.reasons.add("SOURCE_OFFLINE"); break;
      case "unavailable": state.reasons.add("SOURCE_UNAVAILABLE"); break;
      default: { const exhaustive: never = item; return exhaustive; }
    }
  }
}
function requiredReferences(evaluation: Evaluation): readonly string[] {
  const { input, facts, state } = evaluation;
  const references: string[] = [];
  for (const evidenceClass of input.required_evidence) {
    const selected = [...state.selected].filter(reference => facts.get(reference)?.evidence_class === evidenceClass).sort();
    if (selected.length > 0) references.push(...selected);
    else {
      references.push(`required:${evidenceClass}`);
      state.reasons.add("REQUIRED_EVIDENCE_MISSING");
      if (evidenceClass === "linux_live_fact") state.reasons.add("LINUX_LIVE_EVIDENCE_REQUIRED");
      if (evidenceClass === "owner_decision") state.reasons.add("OWNER_DECISION_REQUIRED");
    }
  }
  return references.sort();
}
function policyTimeDecision(policy: ParsedContextPolicy, input: ParsedContextPolicyInput): ContextPolicyReasonCode | null {
  const clock = Date.parse(input.clock);
  if (clock < Date.parse(policy.effective_at)) return "POLICY_NOT_EFFECTIVE";
  if (clock > Date.parse(policy.expires_at)) return "POLICY_EXPIRED";
  return null;
}

export function evaluateContextPolicy(policyValue: unknown, inputValue: unknown): ContextPolicyDecision {
  const policy = parseContextPolicyConfig(policyValue);
  const input = parseContextPolicyInput(inputValue);
  const state: DecisionState = {
    reasons: new Set(), selected: new Set(), excluded: new Set(), conflicting: new Set(), superseded: new Set(),
  };
  const timeReason = policyTimeDecision(policy, input);
  const facts = new Map(input.evidence.filter((item): item is ContextFact => item.kind === "evidence").map(item => [item.ref, item]));
  const evaluation = { policy, input, facts, state };
  if (timeReason !== null) state.reasons.add(timeReason);
  classifySources(evaluation);
  for (const fact of facts.values()) applySupersession(evaluation, fact);
  const priorities = [...state.selected].filter(reference => facts.get(reference)?.evidence_class === "user_confirmed_principle");
  if (priorities.length > 1) conflict(state, priorities, "UNRESOLVED_PRIORITY_CONFLICT");
  const requiredEvidenceRefs = requiredReferences(evaluation);
  const eligible = state.reasons.size === 0;
  return {
    status: eligible ? "eligible" : "abstain",
    policy_id: policy.policy_id,
    reason_codes: eligible ? ["POLICY_SATISFIED"] : sorted(state.reasons),
    selected_refs: sorted(state.selected), excluded_refs: sorted(state.excluded),
    conflicting_refs: sorted(state.conflicting), superseded_refs: sorted(state.superseded),
    required_evidence_refs: requiredEvidenceRefs,
  };
}
