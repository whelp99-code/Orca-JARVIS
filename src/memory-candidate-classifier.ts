import { parseMemoryCandidateInput } from "./memory-candidate-input.js";
import { computeMemoryCandidate } from "./memory-candidate-material.js";
import { parseMemoryCandidatePolicy } from "./memory-candidate-policy.js";
import type { MemoryCandidateClassification } from "./memory-candidate-types.js";
import { memoryDate } from "./memory-candidate-values.js";

export function classifyMemoryCandidate(
  policyValue: unknown,
  inputValue: unknown,
  nowValue: unknown,
): MemoryCandidateClassification {
  const policy = parseMemoryCandidatePolicy(policyValue);
  const input = parseMemoryCandidateInput(inputValue);
  return computeMemoryCandidate(policy, input, {
    now: memoryDate(nowValue),
    approved_decision_valid: false,
  }).classification;
}
