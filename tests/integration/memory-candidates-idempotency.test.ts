import { rmSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  AuthorityDb,
  MemoryCandidateError,
  type MemoryCandidateStore,
} from "../../src/index.js";
import {
  evidenceRef,
  MEMORY_NOW,
  verifiedMemoryInput,
} from "../fixtures/memory-candidate-fixture.js";
import {
  closeMemoryDatabase,
  memoryCandidateStore,
  memoryDatabase,
  memoryPolicyWithRetention,
  memoryRecord,
  memorySource,
  memoryTableCount,
  memoryTableCounts,
} from "../fixtures/memory-candidate-store.js";

function expectReplayConflict(action: () => unknown): void {
  expect(action).toThrowError(expect.objectContaining({ code: "MEMORY_CANDIDATE_REPLAY_CONFLICT" }));
}

describe("Task 27 memory candidate conflict and idempotency", () => {
  it("rejects open conflict without changing prior memory and confirmation-binds supersession", async () => {
    // Given: one already approved candidate for the same subject.
    const database = await memoryDatabase();
    try {
      const candidates = memoryCandidateStore(database.authority);
      const prior = candidates.classify(verifiedMemoryInput());
      const priorRow = database.authority.db.prepare(
        "SELECT * FROM memory_candidates WHERE candidate_id=?",
      ).get(prior.candidate_id);
      const openConflict = verifiedMemoryInput({
        idempotency_key: "candidate:task27:open-conflict",
        statement: "Task 27 has a contradictory technical outcome.",
        conflict: {
          state: "conflict",
          references: [evidenceRef("second_brain_conflict", "conflict:task27")],
        },
      });
      const supersede = verifiedMemoryInput({
        idempotency_key: "candidate:task27:supersede",
        operation: "correct",
        statement: "Task 27 has a verified replacement outcome.",
        conflict: {
          state: "supersede",
          references: [evidenceRef("existing_memory", "memory:task27", { evidence_digest: prior.content_digest })],
        },
      });

      // When: contradiction and replacement evidence are classified.
      const rejected = candidates.classify(openConflict);
      const awaiting = candidates.classify(supersede);

      // Then: conflict cannot approve or overwrite, and correction remains confirmation-bound.
      expect(rejected).toMatchObject({ state: "rejected", classification_reason: "OPEN_CONFLICT" });
      expect(awaiting).toMatchObject({
        state: "awaiting_confirmation",
        classification_reason: "SUPERSEDE_CONFIRMATION_REQUIRED",
      });
      expect(database.authority.db.prepare(
        "SELECT * FROM memory_candidates WHERE candidate_id=?",
      ).get(prior.candidate_id)).toEqual(priorRow);
      expect(memoryTableCount(database.authority, "memory_outbox")).toBe(0);
      expect(memoryTableCount(database.authority, "memory_deletion_requests")).toBe(0);
    } finally {
      closeMemoryDatabase(database);
    }
  });

  it("converges exact replay and conflicts changed bytes under one idempotency key with no partial write", async () => {
    // Given: one committed canonical candidate.
    const database = await memoryDatabase();
    try {
      const input = verifiedMemoryInput();
      const candidates = memoryCandidateStore(database.authority);
      const first = candidates.classify(input);
      const before = memoryTableCounts(database.authority);
      const changedSource = verifiedMemoryInput();
      const references = memorySource(changedSource)["references"];
      if (!Array.isArray(references)) throw new TypeError("references required");
      memoryRecord(references[1])["source_ref"] = "artifact:changed";
      const changes = [
        verifiedMemoryInput({ statement: "Task 27 changed technical verification." }),
        changedSource,
        verifiedMemoryInput({ purpose: "live_awareness" }),
        verifiedMemoryInput({ sensitivity: "sensitive" }),
      ];

      // When/Then: every changed material replay conflicts before a second row or event.
      for (const value of changes) expectReplayConflict(() => candidates.classify(value));
      expectReplayConflict(() => memoryCandidateStore(
        database.authority,
        memoryPolicyWithRetention(30),
      ).classify(input));
      expect(memoryTableCounts(database.authority)).toEqual(before);

      // When: a distinct request key submits byte-identical source/content/operation.
      const alias = candidates.classify(verifiedMemoryInput({ idempotency_key: "candidate:task27:alias" }));

      // Then: it maps to the same canonical candidate without duplicate metadata or events.
      expect(alias).toEqual(first);
      expect(memoryTableCount(database.authority, "memory_candidates")).toBe(1);
      expect(memoryTableCount(database.authority, "memory_candidate_classifications")).toBe(1);
      expect(memoryTableCount(database.authority, "memory_candidate_idempotency")).toBe(2);
      expect(memoryTableCount(database.authority, "personal_operation_audit_events")).toBe(1);
    } finally {
      closeMemoryDatabase(database);
    }
  });

  it("returns the same canonical no-data result after closing and reopening SQLite", async () => {
    // Given: one committed no-data classification.
    const database = await memoryDatabase();
    const input = verifiedMemoryInput({
      second_brain: {
        state: "no_data",
        checked_at: MEMORY_NOW,
        fresh_until: "2026-08-28T12:01:00.000Z",
      },
    });
    let first: ReturnType<MemoryCandidateStore["classify"]>;
    try {
      first = memoryCandidateStore(database.authority).classify(input);
      expect(first).toMatchObject({
        state: "classified",
        delivery: { state: "pending", reason: "SECOND_BRAIN_NO_DATA" },
      });
      database.authority.close();
      const reopened = new AuthorityDb(database.path);
      try {
        const replay = memoryCandidateStore(reopened).classify(input);
        expect(replay).toEqual(first);
        expect(memoryTableCount(reopened, "memory_candidates")).toBe(1);
        expect(memoryTableCount(reopened, "memory_outbox")).toBe(0);
      } finally {
        reopened.close();
      }
    } finally {
      rmSync(database.root, { recursive: true, force: true });
    }
  });

  it("throws a typed conflict and leaves zero writes when the request identity changes", async () => {
    // Given: a valid candidate and one changed source under the same request key.
    const database = await memoryDatabase();
    try {
      const candidates = memoryCandidateStore(database.authority);
      candidates.classify(verifiedMemoryInput());
      const changed = verifiedMemoryInput({ statement: "Changed bytes." });
      const before = memoryTableCounts(database.authority);

      // When/Then: conflict is typed and all table cardinalities remain exact.
      expect(() => candidates.classify(changed)).toThrowError(MemoryCandidateError);
      expect(memoryTableCounts(database.authority)).toEqual(before);
    } finally {
      closeMemoryDatabase(database);
    }
  });
});
