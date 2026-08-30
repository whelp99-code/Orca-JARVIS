import { describe, expect, it } from "vitest";
import {
  memoryCandidateConfidence,
  memoryCandidateDisposition,
  memoryStorageSensitivity,
} from "../../src/memory-candidate-classification-rules.js";
import { parseMemoryCandidateInput } from "../../src/memory-candidate-input.js";
import type { MemoryPolicyOutcome } from "../../src/memory-candidate-policy.js";
import {
  MEMORY_CANDIDATE_CONFIRMATION_GATE,
  type MemoryCandidateInputClass,
  type MemoryCandidatePolicySensitivity,
  type MemoryCandidateReasonCode,
} from "../../src/memory-candidate-types.js";
import {
  approvedDecisionMemoryInput,
  explicitMemoryInput,
  inferredMemoryInput,
  verifiedMemoryInput,
} from "../fixtures/memory-candidate-fixture.js";

const CLASSES = [
  ["explicit_user_instruction", explicitMemoryInput],
  ["verified_outcome", verifiedMemoryInput],
  ["approved_decision", approvedDecisionMemoryInput],
  ["labeled_inference", inferredMemoryInput],
] as const;
const SENSITIVITIES = ["public", "personal", "sensitive", "restricted"] as const;
const POLICY_OUTCOMES: ReadonlyArray<readonly [string, MemoryPolicyOutcome]> = [
  ["allow", outcome("allow", null)],
  ["require", outcome("confirm", null)],
  ["no_data", outcome("no_data", "SECOND_BRAIN_NO_DATA")],
  ["deny", outcome("reject", "POLICY_DENIED")],
];
const CONFIDENCE: Readonly<Record<MemoryCandidateInputClass, "verified" | "confirmed" | "inferred">> = {
  explicit_user_instruction: "confirmed",
  verified_outcome: "verified",
  approved_decision: "verified",
  labeled_inference: "inferred",
  raw_transcript: "verified",
  worker_assertion: "verified",
  unverified_summary: "verified",
  transient_runtime: "verified",
  unlabeled_trait_inference: "inferred",
  model_assertion: "inferred",
};

function outcome(
  status: MemoryPolicyOutcome["status"],
  reason: MemoryPolicyOutcome["reason"],
): MemoryPolicyOutcome {
  return {
    status,
    reason,
    retention_days: 3650,
    candidate_expires_at: "2027-08-28T00:00:00.000Z",
    source_expires_at: "2026-08-29T12:00:00.000Z",
    policy_digest: `sha256:${"a".repeat(64)}`,
  };
}

function expectedReason(
  inputClass: (typeof CLASSES)[number][0],
  sensitivity: MemoryCandidatePolicySensitivity,
  policy: string,
  confirmation: boolean,
): MemoryCandidateReasonCode {
  if (policy === "deny") return "POLICY_DENIED";
  if (policy === "no_data") return "SECOND_BRAIN_NO_DATA";
  if (confirmation) return inputClass === "labeled_inference"
    ? "LABELED_INFERENCE_CONFIRMATION_REQUIRED" : "SENSITIVE_MEMORY_CONFIRMATION_REQUIRED";
  if (inputClass === "explicit_user_instruction") return "EXPLICIT_OWNER_INSTRUCTION_APPROVED";
  if (inputClass === "verified_outcome") return "VERIFIED_OUTCOME_APPROVED";
  if (inputClass === "approved_decision") return "APPROVED_DECISION_APPROVED";
  void sensitivity;
  return "LABELED_INFERENCE_CONFIRMATION_REQUIRED";
}

describe("Task 27 complete classification Cartesian policy", () => {
  it("covers class x sensitivity x confidence x allow/require/no-data/deny", () => {
    let cases = 0;
    for (const [inputClass, factory] of CLASSES) {
      for (const sensitivity of SENSITIVITIES) {
        const input = parseMemoryCandidateInput(factory({
          authority_id: `matrix-${inputClass.replaceAll("_", "-")}-${sensitivity}`,
          sensitivity,
        }));
        for (const [policyName, policy] of POLICY_OUTCOMES) {
          const result = memoryCandidateDisposition({
            input,
            content_digest: `sha256:${"b".repeat(64)}`,
            authority_valid: true,
            policy,
          });
          const confirmation = sensitivity === "sensitive" || sensitivity === "restricted"
            || inputClass === "labeled_inference" || policyName === "require";
          const state = policyName === "deny" ? "rejected" : policyName === "no_data" ? "classified"
            : confirmation ? "awaiting_confirmation" : "approved";
          expect(result, `${inputClass}:${sensitivity}:${policyName}`).toEqual({
            state,
            classification_reason: expectedReason(inputClass, sensitivity, policyName, confirmation),
            required_confirmation: confirmation,
            confirmation_gate: confirmation ? MEMORY_CANDIDATE_CONFIRMATION_GATE : null,
            delivery: state === "approved" ? { state: "not_created", reason: null }
              : state === "classified" ? { state: "pending", reason: "SECOND_BRAIN_NO_DATA" }
                : { state: "blocked", reason: expectedReason(inputClass, sensitivity, policyName, confirmation) },
          });
          expect(memoryCandidateConfidence(input)).toBe(CONFIDENCE[inputClass]);
          expect(memoryStorageSensitivity(input)).toBe(
            sensitivity === "public" || sensitivity === "personal" ? "normal" : sensitivity,
          );
          cases += 1;
        }
      }
    }
    expect(cases).toBe(64);
  });
});
