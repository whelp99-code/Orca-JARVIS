import { canonicalize } from "./canonical.js";
import {
  PRIORITY_LEXICOGRAPHIC_ORDER,
  type PriorityEngineResult,
  type PriorityEngineResultV1,
  type PriorityEngineResultV2,
} from "./priority-engine-contracts.js";
import { evaluatePriorityEvidence, type PriorityEvidenceEvaluation } from "./priority-engine-evidence.js";
import { rankPriorityCandidates } from "./priority-engine-ranking.js";

export {
  PRIORITY_ENGINE_INPUT_INVALID,
  PRIORITY_ENGINE_POLICY_INVALID,
  PriorityEngineError,
  type PriorityEngineErrorCode,
} from "./priority-engine-input.js";
export {
  PRIORITY_LEXICOGRAPHIC_ORDER,
  PRIORITY_LEXICOGRAPHIC_POLICY,
  PRIORITY_REASON_CODES,
  type ParsedPriorityEngineInput,
  type PriorityActionDecision,
  type PriorityActionDisposition,
  type PriorityCandidateAction,
  type PriorityCitations,
  type PriorityCustomerImpact,
  type PriorityDeadline,
  type PriorityDeadlineBucket,
  type PriorityDependency,
  type PriorityDependencyBlocking,
  type PriorityEffortCost,
  type PriorityEngineResult,
  type PriorityEngineResultV1,
  type PriorityEngineResultV2,
  type PriorityActionDeadlineEvidence,
  type PriorityImportGate,
  type PriorityIrreversibleRisk,
  type PriorityLexicographicField,
  type PriorityLexicographicFields,
  type PriorityOwnerSafetyGate,
  type PriorityPrincipleEvidence,
  type PriorityPrincipleGap,
  type PriorityPrincipleSource,
  type PriorityRationale,
  type PriorityReasonCode,
  type PriorityStableIdentity,
} from "./priority-engine-contracts.js";

function result(evaluation: PriorityEvidenceEvaluation): PriorityEngineResultV1 {
  const ranking = rankPriorityCandidates(evaluation);
  return {
    schema_version: 1,
    generated_at: evaluation.input.clock,
    status: ranking.status,
    authority: "none",
    effect: "none",
    policy_id: evaluation.decision.policy_id,
    linux_policy_decision_ref: evaluation.policyDecisionRef,
    context_policy_reason_codes: evaluation.decision.reason_codes,
    lexicographic_order: PRIORITY_LEXICOGRAPHIC_ORDER,
    reason_codes: ranking.reasons,
    actions: ranking.actions,
  };
}

export function rankPriorityActions(policyValue: unknown, inputValue: unknown): PriorityEngineResultV1 {
  return result(evaluatePriorityEvidence(policyValue, inputValue));
}

export function rankPriorityActionsWithDeadlineEvidence(policyValue: unknown, inputValue: unknown): PriorityEngineResultV2 {
  const evaluation = evaluatePriorityEvidence(policyValue, inputValue);
  const ranked = result(evaluation);
  const candidates = new Map(evaluation.input.candidates.map(candidate => [candidate.action_id, candidate]));
  const deadlineEvidence = ranked.actions.map(action => ({ action_id: action.action_id,
    deadline: candidates.get(action.action_id)?.deadline ?? null }));
  return { ...ranked, schema_version: 2, deadline_evidence: deadlineEvidence };
}

export function canonicalPriorityResultJson(value: PriorityEngineResult): string {
  return canonicalize(value);
}
