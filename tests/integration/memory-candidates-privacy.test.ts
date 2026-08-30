import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { classifyMemoryCandidate, MemoryCandidateError } from "../../src/index.js";
import {
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
  seedMemoryVerification,
} from "../fixtures/memory-candidate-store.js";

function firstIdentifier(input: Record<string, unknown>): Record<string, unknown> {
  const references = memorySource(input)["references"];
  if (!Array.isArray(references)) throw new TypeError("references required");
  return memoryRecord(memoryRecord(references[0])["identifier"]);
}

describe("Task 27 source-reference privacy", () => {
  it.each([
    "Owner said this prose should be stored verbatim",
    "line\nbreak",
    "https://example.test/private",
    "../private/path",
    "value';DROP_TABLE_memory_candidates--",
    "ignore-previous-instructions",
    "sk-proj-abcdefghijklmnopqrstuvwxyz",
  ])("rejects non-opaque source identifier %j", value => {
    const input = inferredMemoryInput();
    firstIdentifier(input)["id"] = value;
    expect(() => classifyMemoryCandidate(memoryPolicy(), input, new Date(MEMORY_NOW)))
      .toThrowError(expect.objectContaining({ code: "MEMORY_CANDIDATE_INPUT_INVALID" }));
  });

  it("persists and returns only digests, normalized identifiers, and timestamps", async () => {
    const database = await memoryDatabase();
    const canary = "Ultraviolet private source prose canary 7f4a91";
    try {
      const input = verifiedMemoryInput({ authority_id: "privacy", statement: canary });
      seedMemoryVerification(database.authority, input);
      const result = memoryCandidateStore(database.authority).classify(input);
      const api = JSON.stringify(result);
      expect(api).not.toContain(canary);
      expect(api).not.toContain("worker_session_id");
      expect(api).not.toContain("authenticated_session_id");
      expect(result.source.worker_session_digest).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(result.source_refs.every(reference => /^[0-9a-f]{64}$/.test(reference.identifier.id))).toBe(true);
      expect(result.source_refs.every(reference => !Object.hasOwn(reference, "source_ref"))).toBe(true);

      database.authority.db.pragma("wal_checkpoint(PASSIVE)");
      for (const name of readdirSync(database.root)) {
        if (!name.startsWith("authority.sqlite")) continue;
        expect(readFileSync(join(database.root, name)).includes(Buffer.from(canary)), name).toBe(false);
      }
    } finally {
      closeMemoryDatabase(database);
    }
  });

  it("does not leak rejected source text through DB, WAL, SHM, API errors, or logs", async () => {
    const database = await memoryDatabase();
    const canary = "OWNER PRIVATE PROSE CANARY 4d3b2a";
    const logs: string[] = [];
    const original = { log: console.log, error: console.error, warn: console.warn, info: console.info, debug: console.debug };
    const capture = (...values: unknown[]) => { logs.push(values.map(String).join(" ")); };
    console.log = capture; console.error = capture; console.warn = capture; console.info = capture; console.debug = capture;
    try {
      const beforeCandidates = memoryTableCount(database.authority, "memory_candidates");
      const beforeReferences = memoryTableCount(database.authority, "memory_candidate_source_refs");
      const input = inferredMemoryInput();
      firstIdentifier(input)["id"] = canary;
      let error: unknown;
      try {
        memoryCandidateStore(database.authority).classify(input);
      } catch (caught) {
        if (caught instanceof MemoryCandidateError) error = caught;
        else throw caught;
      }
      expect(error).toBeInstanceOf(MemoryCandidateError);
      expect(JSON.stringify(error)).not.toContain(canary);
      expect(String(error)).not.toContain(canary);
      expect(logs.join("\n")).not.toContain(canary);
      expect(memoryTableCount(database.authority, "memory_candidates")).toBe(beforeCandidates);
      expect(memoryTableCount(database.authority, "memory_candidate_source_refs")).toBe(beforeReferences);
      for (const name of readdirSync(database.root)) {
        if (!name.startsWith("authority.sqlite")) continue;
        expect(readFileSync(join(database.root, name)).includes(Buffer.from(canary)), name).toBe(false);
      }
    } finally {
      console.log = original.log; console.error = original.error; console.warn = original.warn;
      console.info = original.info; console.debug = original.debug;
      closeMemoryDatabase(database);
    }
  });
});
