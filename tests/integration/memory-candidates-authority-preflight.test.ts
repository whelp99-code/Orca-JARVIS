import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MemoryCandidateError, MemoryCandidateStore } from "../../src/index.js";
import {
  approvedDecisionMemoryInput,
  explicitMemoryInput,
  inferredMemoryInput,
  memoryPolicy,
  verifiedMemoryInput,
} from "../fixtures/memory-candidate-fixture.js";
import {
  closeMemoryDatabase,
  memoryCandidateStore,
  memoryDatabase,
  memoryTableCount,
  memoryTableCounts,
  seedMemoryVerification,
} from "../fixtures/memory-candidate-store.js";

const ZERO_WRITE_TABLES = [
  "memory_candidates",
  "memory_candidate_classifications",
  "memory_candidate_idempotency",
  "memory_candidate_source_refs",
  "personal_operation_audit_events",
  "memory_candidate_authority_claims",
  "memory_outbox",
  "memory_outbox_attempts",
  "memory_reconciliation_events",
  "memory_deletion_requests",
  "memory_tombstones",
  "control_effect_attempts",
] as const;

function checkpointBytes(database: Awaited<ReturnType<typeof memoryDatabase>>): Readonly<Record<string, string>> {
  database.authority.db.pragma("wal_checkpoint(TRUNCATE)");
  return Object.fromEntries(readdirSync(database.root)
    .filter(name => name === "authority.sqlite" || name === "authority.sqlite-wal")
    .sort()
    .map(name => [name, readFileSync(join(database.root, name)).toString("base64")]));
}

function authorityFailure(action: () => unknown): string {
  try {
    action();
  } catch (error) {
    if (error instanceof MemoryCandidateError) return error.code;
    throw error;
  }
  throw new TypeError("authority failure required");
}

describe("Task 27 read-only authority preflight", () => {
  it("fails missing owner, verifier, and decision authority identically with zero changed bytes or rows", async () => {
    const cases = [
      ["explicit", explicitMemoryInput({ authority_id: "missing-owner" })],
      ["verified", verifiedMemoryInput({ authority_id: "missing-verifier" })],
      ["decision", approvedDecisionMemoryInput({ authority_id: "missing-decision" })],
    ] as const;
    const codes: string[] = [];
    for (const [name, input] of cases) {
      const database = await memoryDatabase();
      try {
        const beforeCounts = memoryTableCounts(database.authority);
        const beforeBytes = checkpointBytes(database);
        codes.push(authorityFailure(() => memoryCandidateStore(database.authority).classify(input)));
        expect(memoryTableCounts(database.authority), `${name}:all tables`).toEqual(beforeCounts);
        expect(checkpointBytes(database), `${name}:db/wal/shm bytes`).toEqual(beforeBytes);
        for (const table of ZERO_WRITE_TABLES) {
          expect(memoryTableCount(database.authority, table), `${name}:${table}`).toBe(0);
        }
      } finally {
        closeMemoryDatabase(database);
      }
    }
    expect(new Set(codes).size).toBe(1);
  });

  it("rechecks expiry inside the immediate transaction before its first write", async () => {
    const database = await memoryDatabase();
    try {
      const input = verifiedMemoryInput({ authority_id: "expiry-toctou" });
      seedMemoryVerification(database.authority, input);
      const times = ["2026-08-28T12:04:59.999Z", "2026-08-28T12:05:00.000Z"];
      let clockCalls = 0;
      const store = new MemoryCandidateStore(database.authority, memoryPolicy(), () => {
        const value = times[clockCalls];
        clockCalls += 1;
        return new Date(value ?? "2026-08-28T12:05:00.001Z");
      });
      const before = memoryTableCounts(database.authority);
      expect(authorityFailure(() => store.classify(input))).toBe("MEMORY_CANDIDATE_AUTHORITY_INVALID");
      expect(clockCalls).toBe(2);
      expect(memoryTableCounts(database.authority)).toEqual(before);
    } finally {
      closeMemoryDatabase(database);
    }
  });

  it("fails a lost single-use claim generically without adding a losing candidate", async () => {
    const database = await memoryDatabase();
    try {
      const input = verifiedMemoryInput({ authority_id: "single-use-lost" });
      seedMemoryVerification(database.authority, input);
      const store = memoryCandidateStore(database.authority);
      const unrelated = store.classify(inferredMemoryInput({ authority_id: "claim-holder" }));
      database.authority.db.prepare(
        `INSERT INTO memory_candidate_authority_claims(
          authority_kind,authority_id,candidate_id,classification_digest,claimed_at
         ) VALUES(?,?,?,?,?)`,
      ).run("verified_outcome", "verification-single-use-lost", unrelated.candidate_id,
        unrelated.classification_digest, unrelated.created_at);
      const before = memoryTableCounts(database.authority);
      expect(authorityFailure(() => store.classify(input))).toBe("MEMORY_CANDIDATE_AUTHORITY_INVALID");
      expect(memoryTableCounts(database.authority)).toEqual(before);
      expect(memoryTableCount(database.authority, "memory_candidates")).toBe(1);
    } finally {
      closeMemoryDatabase(database);
    }
  });

  it("does not reserve idempotency or audit state before verifier authority exists", async () => {
    const database = await memoryDatabase();
    try {
      const input = verifiedMemoryInput({ authority_id: "late-verifier" });
      const store = memoryCandidateStore(database.authority);
      const before = memoryTableCounts(database.authority);
      const first = authorityFailure(() => store.classify(input));
      const second = authorityFailure(() => store.classify(input));
      expect(second).toBe(first);
      expect(memoryTableCounts(database.authority)).toEqual(before);
    } finally {
      closeMemoryDatabase(database);
    }
  });
});
