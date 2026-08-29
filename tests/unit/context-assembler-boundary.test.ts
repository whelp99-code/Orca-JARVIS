import { describe, expect, it } from "vitest";
import {
  assemblePersonalContext,
  CONTEXT_ASSEMBLER_INPUT_INVALID,
  ContextAssemblerError,
} from "../../src/index.js";
import { contextAssemblerInput } from "../fixtures/context-assembler-input.js";

describe("Task 15 untrusted assembler boundary", () => {
  it("returns a typed Task 15 error for malformed public input", () => {
    // Given: an unknown value without the closed assembler shape.
    const input: unknown = { purpose: "daily_prioritization" };
    // When: the public boundary parses it.
    const action = (): unknown => assemblePersonalContext(input);
    // Then: callers receive the stable typed input error.
    expect(action).toThrowError(expect.objectContaining({
      name: "ContextAssemblerError",
      code: CONTEXT_ASSEMBLER_INPUT_INVALID,
    }));
  });

  it("rejects accessors without executing source-controlled getters", () => {
    // Given: an otherwise valid input with an accessor at the boundary.
    const input = contextAssemblerInput();
    let reads = 0;
    Object.defineProperty(input, "purpose", { enumerable: true, get: () => { reads++; return "changed"; } });
    // When: the public parser inspects descriptors.
    const action = (): unknown => assemblePersonalContext(input);
    // Then: no source code executes and the error remains typed.
    expect(action).toThrow(ContextAssemblerError);
    expect(reads).toBe(0);
  });
});
