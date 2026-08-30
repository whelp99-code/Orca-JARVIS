import { describe, expect, it } from "vitest";
import { classifyMemoryCandidate } from "../../src/memory-candidates.js";
import {
  explicitMemoryInput,
  inferredMemoryInput,
  memoryPolicy,
  MEMORY_NOW,
  verifiedMemoryInput,
} from "../fixtures/memory-candidate-fixture.js";
import {
  closeMemoryDatabase,
  memoryCandidateStore,
  memoryDatabase,
  memoryRecord,
  memorySource,
  memoryTableCount,
} from "../fixtures/memory-candidate-store.js";

function classify(value: unknown) {
  return classifyMemoryCandidate(memoryPolicy(), value, new Date(MEMORY_NOW));
}

describe("Task 27 authoritative provenance remediation", () => {
  it("keeps caller-computable instruction and outcome assertions provisional", async () => {
    const database = await memoryDatabase();
    try {
      const store = memoryCandidateStore(database.authority);
      expect(classify(explicitMemoryInput())).toMatchObject({ state: "rejected", classification_reason: "OWNER_PROVENANCE_INVALID" });
      expect(classify(verifiedMemoryInput())).toMatchObject({ state: "rejected", classification_reason: "UNVERIFIED_OUTCOME" });
      expect(store.classify(explicitMemoryInput())).toMatchObject({ state: "rejected", classification_reason: "OWNER_PROVENANCE_INVALID" });
      expect(store.classify(verifiedMemoryInput())).toMatchObject({ state: "rejected", classification_reason: "UNVERIFIED_OUTCOME" });
      expect(memoryTableCount(database.authority, "memory_outbox")).toBe(0);
    } finally {
      closeMemoryDatabase(database);
    }
  });

  it("rejects prose source references before SQLite persistence", async () => {
    const database = await memoryDatabase();
    try {
      const input = inferredMemoryInput();
      const references = memorySource(input)["references"];
      if (!Array.isArray(references)) throw new TypeError("references required");
      memoryRecord(references[0])["source_ref"] = "Owner said this prose should be stored verbatim";
      expect(() => memoryCandidateStore(database.authority).classify(input))
        .toThrowError(expect.objectContaining({ code: "MEMORY_CANDIDATE_INPUT_INVALID" }));
      expect(memoryTableCount(database.authority, "memory_candidates")).toBe(0);
      expect(memoryTableCount(database.authority, "memory_candidate_source_refs")).toBe(0);
    } finally {
      closeMemoryDatabase(database);
    }
  });
});
