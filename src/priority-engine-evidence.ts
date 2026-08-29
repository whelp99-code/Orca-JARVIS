import { ContextPolicyError, evaluateContextPolicy, type ContextPolicyDecision } from "./context-policy.js";
import { parseContextPolicyConfig, type ParsedContextPolicy } from "./context-policy-input.js";
import {
  PRIORITY_REASON_CODES,
  type ParsedPriorityEngineInput,
  type PriorityPrincipleEvidence,
  type PriorityReasonCode,
} from "./priority-engine-contracts.js";
import {
  PRIORITY_ENGINE_POLICY_INVALID,
  PriorityEngineError,
  parsePriorityEngineInput,
} from "./priority-engine-input.js";
import { SECOND_BRAIN_SOURCE_ID } from "./second-brain-adapter-types.js";

export type PriorityEvidenceEvaluation = {
  readonly input: ParsedPriorityEngineInput;
  readonly decision: ContextPolicyDecision;
  readonly principle: PriorityPrincipleEvidence | null;
  readonly policyDecisionRef: string | null;
  readonly reasons: readonly PriorityReasonCode[];
};
type PrincipleAssessment = {
  readonly principle: PriorityPrincipleEvidence | null;
  readonly policyDecisionRef: string | null;
  readonly reasons: readonly PriorityReasonCode[];
};

const compareText = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;
export function orderedPriorityReasons(values: Iterable<PriorityReasonCode>): readonly PriorityReasonCode[] {
  const selected = new Set(values);
  return PRIORITY_REASON_CODES.filter(code => selected.has(code));
}
function trustedPolicyDecisionRef(reference: string | null, policyId: string): string | null {
  if (reference === null) return null;
  const prefix = `policy:linux:${policyId}:`;
  if (!reference.startsWith(prefix)) return null;
  const selector = reference.slice(prefix.length);
  return /^[a-z0-9][a-z0-9._-]{0,127}$/.test(selector) ? reference : null;
}
function parsePolicy(value: unknown): ParsedContextPolicy {
  try { return parseContextPolicyConfig(value); }
  catch (error) {
    if (error instanceof ContextPolicyError) throw new PriorityEngineError(PRIORITY_ENGINE_POLICY_INVALID);
    throw error;
  }
}
function evaluateContext(policyValue: unknown, input: ParsedPriorityEngineInput): ContextPolicyDecision {
  return evaluateContextPolicy(policyValue, {
    schema_version: 1,
    clock: input.context_policy_input.clock,
    required_evidence: input.context_policy_input.required_evidence,
    evidence: input.context_policy_input.evidence.filter(
      item => item.source_host !== "mac-client" && item.source_host !== "phone-client",
    ),
  });
}
function assessPrinciples(
  input: ParsedPriorityEngineInput,
  decision: ContextPolicyDecision,
  config: ParsedContextPolicy,
): PrincipleAssessment {
  const reasons = new Set<PriorityReasonCode>();
  const eligible: PriorityPrincipleEvidence[] = [];
  let foreignSourceSeen = false;
  if (decision.status === "abstain") reasons.add("PRIORITY_CONTEXT_POLICY_ABSTAINED");
  const policyDecisionRef = trustedPolicyDecisionRef(input.linux_policy_decision_ref, decision.policy_id);
  if (policyDecisionRef === null) reasons.add("PRIORITY_REQUIRED_CITATION_MISSING");
  for (const source of [...input.principles].sort((left, right) => compareText(left.principle_ref, right.principle_ref))) {
    if (source.source_id !== SECOND_BRAIN_SOURCE_ID || source.source_host !== "linux-second-brain") {
      foreignSourceSeen = true;
      continue;
    }
    switch (source.kind) {
      case "gap":
        switch (source.state) {
          case "no_data": reasons.add("PRIORITY_MEMORY_NO_DATA"); break;
          case "stale": reasons.add("PRIORITY_MEMORY_STALE"); break;
          case "offline": reasons.add("PRIORITY_MEMORY_OFFLINE"); break;
          case "unavailable": reasons.add("PRIORITY_MEMORY_UNAVAILABLE"); break;
          default: { const exhaustive: never = source.state; return exhaustive; }
        }
        continue;
      case "evidence": break;
      default: { const exhaustive: never = source; return exhaustive; }
    }
    switch (source.trust) {
      case "user_confirmed": break;
      case "inferred": reasons.add("PRIORITY_PRINCIPLE_INFERRED"); continue;
      case "untrusted": reasons.add("PRIORITY_PRINCIPLE_UNTRUSTED"); continue;
      case "unconfirmed": reasons.add("PRIORITY_PRINCIPLE_UNCONFIRMED"); continue;
      default: { const exhaustive: never = source.trust; return exhaustive; }
    }
    if (Date.parse(source.fresh_until) <= Date.parse(input.clock)) {
      reasons.add("PRIORITY_MEMORY_STALE");
      continue;
    }
    if (!decision.selected_refs.includes(source.principle_ref)) {
      reasons.add("PRIORITY_PRINCIPLE_NOT_POLICY_SELECTED");
      continue;
    }
    if (source.evidence_ref === null || source.content_digest === null) {
      reasons.add("PRIORITY_REQUIRED_CITATION_MISSING");
      continue;
    }
    const gate = source.import_gate;
    const ownerDecisionSelected = gate.decision_ref !== null && decision.selected_refs.includes(gate.decision_ref)
      && input.context_policy_input.evidence.some(item => item.kind === "evidence" && item.ref === gate.decision_ref
        && item.evidence_class === "owner_decision" && item.source_host === "linux-control-plane");
    if (gate.gate_id !== config.gates.mac_vault_transfer || gate.state !== "approved"
      || gate.decision_host !== "linux-control-plane" || !ownerDecisionSelected) {
      reasons.add("PRIORITY_OWNER_IMPORT_APPROVAL_REQUIRED");
      continue;
    }
    eligible.push(source);
  }
  if (eligible.length === 0 && foreignSourceSeen) reasons.add("PRIORITY_PRINCIPLE_NON_LINUX");
  if (eligible.length !== 1 && reasons.size === 0) reasons.add("PRIORITY_PRINCIPLE_NOT_POLICY_SELECTED");
  return {
    principle: eligible.length === 1 ? eligible[0] ?? null : null,
    policyDecisionRef,
    reasons: orderedPriorityReasons(reasons),
  };
}

export function evaluatePriorityEvidence(policyValue: unknown, inputValue: unknown): PriorityEvidenceEvaluation {
  const input = parsePriorityEngineInput(inputValue);
  const config = parsePolicy(policyValue);
  const decision = evaluateContext(policyValue, input);
  const assessment = assessPrinciples(input, decision, config);
  return {
    input,
    decision,
    principle: assessment.principle,
    policyDecisionRef: assessment.policyDecisionRef,
    reasons: assessment.reasons,
  };
}
