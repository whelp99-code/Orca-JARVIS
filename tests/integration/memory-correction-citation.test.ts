import { describe, expect, it } from "vitest";
import { correctedCitationRead } from "../fixtures/memory-correction-citation.js";

describe("corrected provider result citation boundary", () => {
  it("accepts the superseding fact when its original sid marker survives", async () => {
    // Given: a synthetic corrected page served by a real MCP subprocess.
    // When: the consumer resolves search evidence through its normal parser.
    const result = await correctedCitationRead(true);
    // Then: the corrected fact remains bound to its cited source.
    expect(result).toMatchObject({ kind: "current", evidence: [{ sid: "a1b2c3d4",
      source_ref: "fixture:correction", excerpt: "corrected-7391[^a1b2c3d4]" }] });
  });
  it("rejects the superseding fact when only an unused footnote definition remains", async () => {
    // Given: the same result without its inline citation marker.
    // When: the consumer parses that response, not the provider's success prose.
    const result = await correctedCitationRead(false);
    // Then: uncited content remains invalid.
    expect(result).toMatchObject({ kind: "invalid", code: "SECOND_BRAIN_CITATION_MISSING" });
  });
});
