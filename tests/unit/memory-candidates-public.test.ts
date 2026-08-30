import { describe, expect, it } from "vitest";
import * as jarvis from "../../src/index.js";

const REQUIRED_EXPORTS = [
  "classifyMemoryCandidate",
  "MemoryCandidateStore",
  "MemoryCandidateError",
  "MEMORY_CANDIDATE_REASON_CODES",
  "MEMORY_CANDIDATE_CONFIRMATION_GATE",
] as const;

const FORBIDDEN_EXPORTS = [
  "SecondBrainMemoryWriter",
  "MemoryOutboxDispatcher",
  "MemoryDeliveryWorker",
  "MemoryDeletionExecutor",
  "MemoryModelClassifier",
] as const;

describe("Task 27 public memory candidate boundary", () => {
  it("exports classification and authority persistence without effect surfaces", () => {
    // Given: the package-root public module.
    const api: Readonly<Record<string, unknown>> = jarvis;

    // When/Then: only classifier/store contracts are public for Task 27.
    for (const name of REQUIRED_EXPORTS) expect(api[name], name).toBeDefined();
    for (const name of FORBIDDEN_EXPORTS) expect(api[name], name).toBeUndefined();
  });
});
