import { describe, expect, it } from "vitest";
import { assemblePersonalContext, AuthorityDb } from "../../src/index.js";
import { contextAssemblerInput, CONTEXT_NOW } from "../fixtures/context-assembler-input.js";
import { tempDb } from "../helpers.js";

describe("assembled context snapshot delivers a model request", () => {
  it("does not send when snapshot persist is rejected", async () => {
    const db = new AuthorityDb(tempDb());
    await db.migrate();
    try {
      expect(() => db.persistAssembledContextSnapshot(contextAssemblerInput(), [], CONTEXT_NOW)).toThrow();
      expect(db.lastAssembledModelCapture()).toBeUndefined();
      expect(db.assembledModelSendCount()).toBe(0);
    } finally {
      db.close();
    }
  });

  it("sends query, body, source, and version only after persist succeeds", async () => {
    const db = new AuthorityDb(tempDb());
    await db.migrate();
    try {
      const input = contextAssemblerInput();
      const live = (input as { observations?: unknown[] }).observations ?? [];
      for (const observation of live) {
        db.persistObservation(observation, CONTEXT_NOW);
      }
      const snapshot = assemblePersonalContext(input);
      const memory = snapshot.evidence.find((item) => item.kind === "confirmed_memory");
      if (memory === undefined) throw new Error("confirmed memory required");
      const stored = db.persistAssembledContextSnapshot(input, [{
        memory_ref: snapshot.payload.included_memory_refs[0] ?? memory.evidence_id,
        evidence_id: memory.evidence_id,
        source_id: memory.source_id,
        digest: memory.digest,
        observed_at: memory.observed_at,
        fresh_until: snapshot.expires_at,
      }], CONTEXT_NOW);
      expect(stored.observation_count).toBeGreaterThanOrEqual(0);
      const capture = db.lastAssembledModelCapture();
      expect(capture?.json).toContain("what now?");
      expect(capture?.json).toContain("Prioritize confirmed customer");
      expect(capture?.json).toContain("src:pos:v1:second-brain:primary");
      expect(capture?.json).toMatch(/sha256:[0-9a-f]{64}/);
      expect(db.assembledModelSendCount()).toBe(1);
    } finally {
      db.close();
    }
  });
});
