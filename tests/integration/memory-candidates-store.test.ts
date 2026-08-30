import { describe, expect, it } from "vitest";
import {
  approvedDecisionMemoryInput,
  explicitMemoryInput,
  inferredMemoryInput,
  REJECTED_SOURCE_CLASSES,
  rejectedMemoryInput,
  verifiedMemoryInput,
} from "../fixtures/memory-candidate-fixture.js";
import {
  closeMemoryDatabase,
  memoryCandidateStore,
  memoryDatabase,
  memoryRecord,
  memoryTableCount,
  memoryTableCounts,
  memoryTableDelta,
  seedMemoryDecision,
} from "../fixtures/memory-candidate-store.js";

describe("Task 27 authority-side memory candidate persistence", () => {
  it("persists one verified candidate, immutable metadata, ordered refs, and no effect rows", async () => {
    // Given: a fresh migrated authority database and one verified outcome.
    const database = await memoryDatabase();
    try {
      const before = memoryTableCounts(database.authority);
      const candidates = memoryCandidateStore(database.authority);

      // When: the exact candidate is classified twice.
      const first = candidates.classify(verifiedMemoryInput());
      const replay = candidates.classify(verifiedMemoryInput());
      const after = memoryTableCounts(database.authority);

      // Then: one atomic identity and audit event persist while every effect table remains unchanged.
      expect(replay).toEqual(first);
      expect(first.state).toBe("approved");
      const expected: Readonly<Record<string, number>> = {
        memory_candidates: 1,
        memory_candidate_classifications: 1,
        memory_candidate_source_refs: 2,
        memory_candidate_idempotency: 1,
        personal_operation_audit_events: 1,
      };
      for (const table of Object.keys(after)) {
        expect(memoryTableDelta(before, after, table), table).toBe(expected[table] ?? 0);
      }
      expect(memoryTableCount(database.authority, "memory_outbox")).toBe(0);
      expect(memoryTableCount(database.authority, "memory_outbox_attempts")).toBe(0);
      expect(memoryTableCount(database.authority, "memory_reconciliation_events")).toBe(0);
      expect(memoryTableCount(database.authority, "memory_deletion_requests")).toBe(0);
      expect(memoryTableCount(database.authority, "memory_tombstones")).toBe(0);
      expect(() => database.authority.db.prepare(
        "UPDATE memory_candidate_classifications SET classification_reason='forged' WHERE candidate_id=?",
      ).run(first.candidate_id)).toThrow("immutable memory candidate classification");
      expect(() => database.authority.db.prepare(
        "DELETE FROM memory_candidate_source_refs WHERE candidate_id=?",
      ).run(first.candidate_id)).toThrow("immutable memory candidate source reference");
    } finally {
      closeMemoryDatabase(database);
    }
  });

  it("persists exact explicit, inferred, sensitive, and approved-decision classifications", async () => {
    // Given: all four closed source classes and one real authority receipt row.
    const database = await memoryDatabase();
    try {
      const decision = approvedDecisionMemoryInput();
      seedMemoryDecision(database.authority, decision);
      const candidates = memoryCandidateStore(database.authority);

      // When: each distinct candidate is classified once.
      const explicit = candidates.classify(explicitMemoryInput());
      const sensitive = candidates.classify(explicitMemoryInput({
        idempotency_key: "candidate:task27:sensitive",
        statement: "Remember my sensitive bounded preference.",
        sensitivity: "sensitive",
      }));
      const inferred = candidates.classify(inferredMemoryInput());
      const approved = candidates.classify(decision);

      // Then: only normal authenticated/verified sources auto-stage.
      expect(explicit).toMatchObject({ state: "approved", confidence: "confirmed" });
      expect(sensitive).toMatchObject({ state: "awaiting_confirmation", storage_sensitivity: "sensitive" });
      expect(inferred).toMatchObject({ state: "awaiting_confirmation", confidence: "inferred" });
      expect(approved).toMatchObject({ state: "approved", input_class: "approved_decision" });
      expect(memoryTableCount(database.authority, "memory_candidates")).toBe(4);
      expect(memoryTableCount(database.authority, "memory_candidate_classifications")).toBe(4);
      expect(memoryTableCount(database.authority, "memory_outbox")).toBe(0);
      expect(memoryTableCount(database.authority, "control_command_receipts")).toBe(1);
    } finally {
      closeMemoryDatabase(database);
    }
  });

  it("persists prohibited and foreign provenance only as terminal rejected or expired audits", async () => {
    // Given: every prohibited source class, secret content, a policy field, and missing decision authority.
    const database = await memoryDatabase();
    try {
      const candidates = memoryCandidateStore(database.authority);
      const values = [
        ...REJECTED_SOURCE_CLASSES.map(sourceClass => rejectedMemoryInput(sourceClass)),
        verifiedMemoryInput({
          idempotency_key: "candidate:task27:secret",
          statement: "access_token=ghp_abcdefghijklmnopqrstuvwxyz",
        }),
        verifiedMemoryInput({
          idempotency_key: "candidate:task27:field",
          payload_fields: ["summary", "raw_body"],
        }),
        approvedDecisionMemoryInput({ idempotency_key: "candidate:task27:missing-decision" }),
      ];

      // When: each bounded input is classified.
      const results = values.map(value => candidates.classify(value));

      // Then: immutable audit rows exist, but approved/outbox/delivery/deletion effects remain zero.
      expect(results.every(result => result.state === "rejected" || result.state === "expired")).toBe(true);
      expect(memoryTableCount(database.authority, "memory_candidates")).toBe(values.length);
      expect(memoryTableCount(database.authority, "memory_candidates"))
        .toBe(memoryTableCount(database.authority, "memory_candidate_classifications"));
      expect(memoryRecord(database.authority.db.prepare(
        "SELECT COUNT(*) AS count FROM memory_candidates WHERE state='approved'",
      ).get())["count"]).toBe(0);
      for (const table of ["memory_outbox", "memory_outbox_attempts", "memory_reconciliation_events",
        "memory_deletion_requests", "memory_tombstones", "notification_deliveries"]) {
        expect(memoryTableCount(database.authority, table), table).toBe(0);
      }
    } finally {
      closeMemoryDatabase(database);
    }
  });
});
