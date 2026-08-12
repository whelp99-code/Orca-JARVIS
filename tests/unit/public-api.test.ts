import { describe, expect, it } from "vitest";
import * as publicApi from "../../src/index.js";

const directMutationApis = [
  "writeCurrentState",
  "LoopGraph",
  "RunbookEngine",
  "DurableMicroLoopRuntime",
  "AgentOpsMicroLoops",
] as const;

describe("package root public API", () => {
  it("keeps generic mutation engines behind the approved executor", () => {
    expect(directMutationApis.filter(name => name in publicApi)).toEqual([]);
  });
});
