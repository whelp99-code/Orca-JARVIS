import { describe, expect, it } from "vitest";
import {
  approvedDecisionMemoryInput,
  explicitMemoryInput,
  inferredMemoryInput,
  MEMORY_NOW,
  verifiedMemoryInput,
} from "../fixtures/memory-candidate-fixture.js";
import {
  closeMemoryDatabase,
  memoryCandidateStore,
  memoryDatabase,
  memoryTableCount,
  seedMemoryAuthority,
} from "../fixtures/memory-candidate-store.js";

const CLASSES = [
  ["explicit_user_instruction", explicitMemoryInput, "confirmed"],
  ["verified_outcome", verifiedMemoryInput, "verified"],
  ["approved_decision", approvedDecisionMemoryInput, "verified"],
  ["labeled_inference", inferredMemoryInput, "inferred"],
] as const;
const SENSITIVITIES = ["public", "personal", "sensitive", "restricted"] as const;
const MODES = ["available", "no_data", "deny"] as const;

function approvedReason(inputClass: (typeof CLASSES)[number][0]): string {
  if (inputClass === "explicit_user_instruction") return "EXPLICIT_OWNER_INSTRUCTION_APPROVED";
  if (inputClass === "verified_outcome") return "VERIFIED_OUTCOME_APPROVED";
  if (inputClass === "approved_decision") return "APPROVED_DECISION_APPROVED";
  return "LABELED_INFERENCE_CONFIRMATION_REQUIRED";
}

describe("Task 27 authoritative persistence policy matrix", () => {
  it("covers every accepted class and sensitivity across allow/require/no-data/deny with no effects", async () => {
    const database = await memoryDatabase();
    try {
      const store = memoryCandidateStore(database.authority);
      const policyOutcomes = { allow: 0, require: 0, no_data: 0, deny: 0 };
      let cases = 0;
      for (const [inputClass, factory, confidence] of CLASSES) {
        for (const sensitivity of SENSITIVITIES) {
          for (const mode of MODES) {
            const id = `${inputClass.replaceAll("_", "-")}-${sensitivity}-${mode}`;
            const input = factory({
              authority_id: `matrix-${id}`,
              idempotency_key: `candidate:matrix:${id}`,
              sensitivity,
              payload_fields: mode === "deny" ? ["summary", "raw_body"] : ["summary"],
              second_brain: mode === "no_data"
                ? { state: "no_data", checked_at: MEMORY_NOW, fresh_until: "2026-08-28T12:01:00.000Z" }
                : { state: "available" },
            });
            if (inputClass !== "labeled_inference") seedMemoryAuthority(database.authority, input);
            const result = store.classify(input);
            const confirmation = sensitivity === "sensitive" || sensitivity === "restricted"
              || inputClass === "labeled_inference";
            const state = mode === "deny" ? "rejected" : mode === "no_data" ? "classified"
              : confirmation ? "awaiting_confirmation" : "approved";
            const reason = mode === "deny" ? "PROHIBITED_POLICY_FIELD"
              : mode === "no_data" ? "SECOND_BRAIN_NO_DATA"
                : confirmation
                  ? inputClass === "labeled_inference"
                    ? "LABELED_INFERENCE_CONFIRMATION_REQUIRED"
                    : "SENSITIVE_MEMORY_CONFIRMATION_REQUIRED"
                  : approvedReason(inputClass);
            expect(result, id).toMatchObject({
              input_class: inputClass,
              confidence,
              policy_sensitivity: sensitivity,
              storage_sensitivity: sensitivity === "public" || sensitivity === "personal" ? "normal" : sensitivity,
              state,
              classification_reason: reason,
              required_confirmation: confirmation,
              confirmation_gate: confirmation ? "PERSONAL_MEMORY_CONFIRMATION" : null,
            });
            if (mode === "deny") policyOutcomes.deny += 1;
            else if (mode === "no_data") policyOutcomes.no_data += 1;
            else if (sensitivity === "sensitive" || sensitivity === "restricted") policyOutcomes.require += 1;
            else policyOutcomes.allow += 1;
            cases += 1;
          }
        }
      }
      expect(cases).toBe(48);
      expect(policyOutcomes).toEqual({ allow: 8, require: 8, no_data: 16, deny: 16 });
      expect(memoryTableCount(database.authority, "memory_candidates")).toBe(48);
      expect(memoryTableCount(database.authority, "memory_candidate_classifications")).toBe(48);
      expect(memoryTableCount(database.authority, "personal_operation_audit_events")).toBe(48);
      expect(memoryTableCount(database.authority, "memory_candidate_authority_claims")).toBe(24);
      for (const table of [
        "memory_outbox", "memory_outbox_attempts", "memory_reconciliation_events", "memory_deletion_requests",
        "memory_tombstones", "notification_deliveries", "control_effect_attempts", "outbox", "consumer_inbox",
      ]) expect(memoryTableCount(database.authority, table), table).toBe(0);
    } finally {
      closeMemoryDatabase(database);
    }
  });
});
