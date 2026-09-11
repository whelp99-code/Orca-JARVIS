import { describe, expect, it } from "vitest";
import { AuthorityDb } from "../../src/index.js";
import { contextAssemblerInput, CONTEXT_NOW } from "../fixtures/context-assembler-input.js";
import { tempDb } from "../helpers.js";

describe("assembled context snapshot delivers a model request", () => {
  it("sends query, body, source, and version through persistAssembledContextSnapshot", async () => {
    const db = new AuthorityDb(tempDb());
    await db.migrate();
    try {
      try {
        db.persistAssembledContextSnapshot(contextAssemblerInput(), [], CONTEXT_NOW);
      } catch {
        // Snapshot evidence binding may reject empty evidence; transport must still fire.
      }
      const capture = db.lastAssembledModelCapture();
      expect(capture?.session_id).toBe(`session:${CONTEXT_NOW}`);
      expect(capture?.json).toContain("what now?");
      expect(capture?.json).toContain("Prioritize confirmed customer");
      expect(capture?.json).toContain("src:pos:v1:second-brain:primary");
      expect(capture?.json).toMatch(/sha256:[0-9a-f]{64}/);
      expect(capture?.bytes).toBeLessThanOrEqual(4096);
      expect(capture?.no_data).toBe(false);
      expect(db.lastAssembledModelCapture()?.bytes).toBe(capture?.bytes);
    } finally {
      db.close();
    }
  });
});
