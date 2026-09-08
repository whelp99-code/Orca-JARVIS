import { describe, expect, it } from "vitest";
import {
  DEFAULT_MORNING_BRIEF_LIMITS,
  generateMorningBrief,
  parseMorningBriefInput,
  verifyMorningBriefResult,
} from "../../src/index.js";

describe("morning brief public API", () => {
  it("exports the parser, generator, and frozen default bounds from the package root", () => {
    // Given: the package-root barrel
    // When / Then: machine-consumed public symbols and values are available
    expect(typeof parseMorningBriefInput).toBe("function");
    expect(typeof generateMorningBrief).toBe("function");
    expect(typeof verifyMorningBriefResult).toBe("function");
    expect(DEFAULT_MORNING_BRIEF_LIMITS).toEqual({
      max_needs_you_first: 5,
      max_waiting: 5,
      max_fyi: 8,
      max_total_items: 18,
      max_sources_per_item: 64,
      max_copy_bytes: 160,
      max_total_bytes: 32_768,
    });
  });
});
