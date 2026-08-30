import { describe, expect, it } from "vitest";
import {
  approvedDecisionMemoryInput,
  evidenceRef,
  explicitMemoryInput,
  MEMORY_AUTHORITY_EXPIRES,
  MEMORY_NOW,
  verifiedMemoryInput,
} from "../fixtures/memory-candidate-fixture.js";
import {
  closeMemoryDatabase,
  memoryCandidateStore,
  memoryDatabase,
  memoryRecord,
  memoryTableCount,
  seedMemoryAuthority,
} from "../fixtures/memory-candidate-store.js";

const SIGNED_CLASSES = [
  ["explicit_user_instruction", explicitMemoryInput, "confirmed", "EXPLICIT_OWNER_INSTRUCTION_APPROVED"],
  ["verified_outcome", verifiedMemoryInput, "verified", "VERIFIED_OUTCOME_APPROVED"],
  ["approved_decision", approvedDecisionMemoryInput, "verified", "APPROVED_DECISION_APPROVED"],
] as const;
const SENSITIVITIES = ["public", "personal", "sensitive", "restricted"] as const;
const SECOND_BRAIN_STATES = ["available", "no_data"] as const;
const CONFLICT_STATES = ["none", "conflict"] as const;
const EFFECT_TABLES = [
  "memory_outbox", "memory_outbox_attempts", "memory_reconciliation_events", "memory_deletion_requests",
  "memory_tombstones", "notification_deliveries", "control_effect_attempts", "outbox", "consumer_inbox",
] as const;

describe("Task 27 signed authority persistence policy matrix", () => {
  it("persists the literal 3 x 4 x 2 x 2 matrix with exact terminal claims and zero effects", async () => {
    const database = await memoryDatabase();
    try {
      const store = memoryCandidateStore(database.authority);
      const states: Record<string, number> = {
        approved: 0,
        awaiting_confirmation: 0,
        classified: 0,
        rejected: 0,
      };
      let cases = 0;
      for (const [inputClass, factory, confidence, approvedReason] of SIGNED_CLASSES) {
        for (const sensitivity of SENSITIVITIES) {
          for (const secondBrainState of SECOND_BRAIN_STATES) {
            for (const conflictState of CONFLICT_STATES) {
              const id = [inputClass, sensitivity, secondBrainState, conflictState].join("-").replaceAll("_", "-");
              const input = factory({
                authority_id: `matrix-${id}`,
                idempotency_key: `candidate:matrix:${id}`,
                sensitivity,
                second_brain: secondBrainState === "no_data"
                  ? { state: "no_data", checked_at: MEMORY_NOW, fresh_until: "2026-08-28T12:01:00.000Z" }
                  : { state: "available" },
                conflict: conflictState === "conflict"
                  ? { state: "conflict", references: [evidenceRef("second_brain_conflict", `matrix-${id}`)] }
                  : { state: "none", references: [] },
              });
              seedMemoryAuthority(database.authority, input);
              const result = store.classify(input);
              const confirmation = sensitivity === "sensitive" || sensitivity === "restricted";
              const state = conflictState === "conflict" ? "rejected"
                : secondBrainState === "no_data" ? "classified"
                  : confirmation ? "awaiting_confirmation" : "approved";
              const reason = conflictState === "conflict" ? "OPEN_CONFLICT"
                : secondBrainState === "no_data" ? "SECOND_BRAIN_NO_DATA"
                  : confirmation ? "SENSITIVE_MEMORY_CONFIRMATION_REQUIRED" : approvedReason;
              const delivery = state === "approved" ? { state: "not_created", reason: null }
                : state === "classified" ? { state: "pending", reason: "SECOND_BRAIN_NO_DATA" }
                  : { state: "blocked", reason };
              expect(result, id).toMatchObject({
                input_class: inputClass,
                confidence,
                policy_sensitivity: sensitivity,
                storage_sensitivity: sensitivity === "public" || sensitivity === "personal" ? "normal" : sensitivity,
                retention_days: 3650,
                state,
                classification_reason: reason,
                required_confirmation: confirmation,
                confirmation_gate: confirmation ? "PERSONAL_MEMORY_CONFIRMATION" : null,
                confirmation_expires_at: confirmation ? MEMORY_AUTHORITY_EXPIRES : null,
                delivery,
              });
              const claim = memoryRecord(database.authority.db.prepare(
                `SELECT candidate_id,classification_digest FROM memory_candidate_authority_claims
                 WHERE candidate_id=?`,
              ).get(result.candidate_id));
              expect(claim, `${id}:claim`).toEqual({
                candidate_id: result.candidate_id,
                classification_digest: result.classification_digest,
              });
              for (const table of EFFECT_TABLES) expect(memoryTableCount(database.authority, table), `${id}:${table}`).toBe(0);
              states[state] = (states[state] ?? 0) + 1;
              cases += 1;
            }
          }
        }
      }
      expect(cases).toBe(48);
      expect(states).toEqual({ approved: 6, awaiting_confirmation: 6, classified: 12, rejected: 24 });
      expect(memoryTableCount(database.authority, "memory_candidates")).toBe(48);
      expect(memoryTableCount(database.authority, "memory_candidate_classifications")).toBe(48);
      expect(memoryTableCount(database.authority, "memory_candidate_idempotency")).toBe(48);
      expect(memoryTableCount(database.authority, "memory_candidate_source_refs")).toBe(120);
      expect(memoryTableCount(database.authority, "personal_operation_audit_events")).toBe(48);
      expect(memoryTableCount(database.authority, "memory_candidate_authority_claims")).toBe(48);
    } finally {
      closeMemoryDatabase(database);
    }
  });
});
