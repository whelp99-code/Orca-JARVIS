import { rmSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  AuthorityDb,
  MemoryCandidateError,
  type MemoryCandidateStore,
} from "../../src/index.js";
import {
  approvedDecisionMemoryInput,
  evidenceRef,
  explicitMemoryInput,
  MEMORY_NOW,
  verifiedMemoryInput,
} from "../fixtures/memory-candidate-fixture.js";
import {
  closeMemoryDatabase,
  memoryCandidateStore,
  memoryDatabase,
  memoryPolicyWithRetention,
  memorySource,
  memoryTableCount,
  memoryTableCounts,
  seedMemoryAuthority,
  seedMemoryVerification,
} from "../fixtures/memory-candidate-store.js";

function expectReplayConflict(action: () => unknown): void {
  expect(action).toThrowError(expect.objectContaining({ code: "MEMORY_CANDIDATE_REPLAY_CONFLICT" }));
}
function expectAuthorityFailure(action: () => unknown): void {
  expect(action).toThrowError(expect.objectContaining({ code: "MEMORY_CANDIDATE_AUTHORITY_INVALID" }));
}

describe("Task 27 memory candidate conflict and idempotency", () => {
  it("rejects open conflict without changing prior memory and confirmation-binds supersession", async () => {
    // Given: one already approved candidate for the same subject.
    const database = await memoryDatabase();
    try {
      const candidates = memoryCandidateStore(database.authority);
      const priorInput = verifiedMemoryInput();
      seedMemoryVerification(database.authority, priorInput);
      const prior = candidates.classify(priorInput);
      const priorRow = database.authority.db.prepare(
        "SELECT * FROM memory_candidates WHERE candidate_id=?",
      ).get(prior.candidate_id);
      const openConflict = verifiedMemoryInput({
        authority_id: "open-conflict",
        idempotency_key: "candidate:task27:open-conflict",
        statement: "Task 27 has a contradictory technical outcome.",
        conflict: {
          state: "conflict",
          references: [evidenceRef("second_brain_conflict", "conflict-task27")],
        },
      });
      const supersede = verifiedMemoryInput({
        authority_id: "supersede",
        idempotency_key: "candidate:task27:supersede",
        operation: "correct",
        statement: "Task 27 has a verified replacement outcome.",
        conflict: {
          state: "supersede",
          references: [evidenceRef("existing_memory", "memory-task27", { evidence_digest: prior.content_digest })],
        },
      });
      seedMemoryVerification(database.authority, openConflict);
      seedMemoryVerification(database.authority, supersede);

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

  it("consumes signed rejected and expired authority before exact alias replay", async () => {
    const database = await memoryDatabase();
    try {
      const classes = [
        ["instruction", explicitMemoryInput],
        ["outcome", verifiedMemoryInput],
        ["decision", approvedDecisionMemoryInput],
      ] as const;
      const outcomes = ["rejected", "expired"] as const;
      const store = memoryCandidateStore(database.authority);
      for (const [sourceClass, factory] of classes) {
        for (const outcome of outcomes) {
          const id = `${sourceClass}-${outcome}`;
          const input = factory({
            authority_id: `terminal-${id}`,
            idempotency_key: `candidate:terminal:${id}`,
            payload_fields: outcome === "rejected" ? ["summary", "raw_body"] : ["summary"],
            conflict: outcome === "expired" ? {
              state: "conflict",
              references: [evidenceRef("second_brain_conflict", `terminal-${id}`, {
                fresh_until: MEMORY_NOW,
                expires_at: MEMORY_NOW,
              })],
            } : { state: "none", references: [] },
          });
          seedMemoryAuthority(database.authority, input);
          const first = store.classify(input);
          expect(first, id).toMatchObject({
            state: outcome,
            classification_reason: outcome === "rejected" ? "PROHIBITED_POLICY_FIELD" : "SOURCE_EXPIRED",
          });
          expect(database.authority.db.prepare(
            `SELECT candidate_id,classification_digest FROM memory_candidate_authority_claims
             WHERE candidate_id=?`,
          ).get(first.candidate_id), `${id}:claim`).toEqual({
            candidate_id: first.candidate_id,
            classification_digest: first.classification_digest,
          });

          const alias = structuredClone(input);
          alias["idempotency_key"] = `candidate:terminal:${id}:alias`;
          const beforeAlias = memoryTableCounts(database.authority);
          expect(store.classify(alias), `${id}:alias`).toEqual(first);
          const afterAlias = memoryTableCounts(database.authority);
          for (const [table, count] of Object.entries(afterAlias)) {
            expect(count - (beforeAlias[table] ?? 0), `${id}:alias:${table}`)
              .toBe(table === "memory_candidate_idempotency" ? 1 : 0);
          }

          const corrected = structuredClone(input);
          corrected["idempotency_key"] = `candidate:terminal:${id}:corrected`;
          corrected["statement"] = `${String(corrected["statement"])} corrected`;
          const beforeCorrected = memoryTableCounts(database.authority);
          expectAuthorityFailure(() => store.classify(corrected));
          expect(memoryTableCounts(database.authority), `${id}:corrected`).toEqual(beforeCorrected);
        }
      }
      expect(memoryTableCount(database.authority, "memory_candidate_authority_claims")).toBe(6);
      for (const table of [
        "memory_outbox", "memory_outbox_attempts", "memory_reconciliation_events", "memory_deletion_requests",
        "memory_tombstones", "notification_deliveries", "control_effect_attempts", "outbox", "consumer_inbox",
      ]) expect(memoryTableCount(database.authority, table), table).toBe(0);
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
      seedMemoryVerification(database.authority, input);
      const first = candidates.classify(input);
      const before = memoryTableCounts(database.authority);
      const changedSource = verifiedMemoryInput();
      memorySource(changedSource)["evidence_id"] = "verification-changed";
      const changes = [
        verifiedMemoryInput({ statement: "Task 27 changed technical verification." }),
        changedSource,
        verifiedMemoryInput({ purpose: "live_awareness" }),
        verifiedMemoryInput({ sensitivity: "sensitive" }),
      ];

      // When/Then: changed authority bindings fail preflight before replay or persistence.
      for (const value of changes) expectAuthorityFailure(() => candidates.classify(value));
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
      seedMemoryVerification(database.authority, input);
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
      rmSync(database.anchorsRoot, { recursive: true, force: true });
    }
  });

  it("throws a typed conflict and leaves zero writes when the request identity changes", async () => {
    // Given: a valid candidate and one changed source under the same request key.
    const database = await memoryDatabase();
    try {
      const candidates = memoryCandidateStore(database.authority);
      const input = verifiedMemoryInput();
      seedMemoryVerification(database.authority, input);
      candidates.classify(input);
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
