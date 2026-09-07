import { describe, expect, it } from "vitest";
import { parseMemoryPlainText } from "../../src/memory-plain-text.js";
import { parseMemoryCandidateInput } from "../../src/memory-candidate-input.js";
import { inferredMemoryInput } from "../fixtures/memory-candidate-fixture.js";

describe("explicit plain-text-v1 candidate body", () => {
  it.each(["first\nsecond", "first\r\nsecond", "first\rsecond", "\t first\n\n second \t", "\ufeffbody", "\u0085body\u0085", "😀 body"])("preserves exact accepted bytes: %j", statement => {
    expect(parseMemoryPlainText(statement)).toBe(statement);
    const value = { ...inferredMemoryInput(), schema_version: 2, body_profile: "plain-text-v1", statement };
    expect(parseMemoryCandidateInput(value)).toMatchObject({ schema_version: 2, body_profile: "plain-text-v1", statement });
  });
  it.each(["\n\t\r ", "x\u0000y", "x\u000by", "x\u007fy", "\ud800", "e\u0301", "가".repeat(1366), "[^".repeat(1025), Array(65).fill("x").join("\n")])("rejects invalid, empty or unrepresentable body: %j", statement => {
    expect(parseMemoryPlainText(statement)).toBeUndefined();
    expect(() => parseMemoryCandidateInput({ ...inferredMemoryInput(), schema_version: 2, body_profile: "plain-text-v1", statement })).toThrow();
  });
  it("keeps V1 frozen and requires both version and profile", () => {
    const input = inferredMemoryInput({ statement: "first\nsecond" });
    for (const value of [input, { ...input, schema_version: 2 }, { ...input, body_profile: "plain-text-v1" },
      { ...input, schema_version: 2, body_profile: "plain-text-v1", operation: "correct" }]) {
      expect(() => parseMemoryCandidateInput(value)).toThrow();
    }
    expect(parseMemoryPlainText(Array(64).fill("x").join("\n"))).toBeDefined();
    expect(parseMemoryPlainText("[^".repeat(1024))).toBeDefined();
  });
});
