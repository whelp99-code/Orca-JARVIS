import { describe, expect, it } from "vitest";
import * as publicApi from "../../src/index.js";
import * as negativeEvidence from "../../src/negative-evidence.js";

const directMutationApis = [
  "writeCurrentState",
  "LoopGraph",
  "RunbookEngine",
  "DurableMicroLoopRuntime",
  "AgentOpsMicroLoops",
  "recordNegativeEvidence",
  "parseNegativeEvidenceInput",
  "parseNegativeEvidenceBinding",
  "negativeEvidenceId",
] as const;

describe("package root public API", () => {
  it("keeps generic mutation engines behind the approved executor", () => {
    expect(directMutationApis.filter(name => name in publicApi)).toEqual([]);
  });

  it("does not export a standalone writer that can persist evidence without settlement", () => {
    expect("recordNegativeEvidence" in negativeEvidence).toBe(false);
    expect("persistNegativeEvidence" in negativeEvidence).toBe(false);
    expect(typeof negativeEvidence.appendSettledNegativeEvidence).toBe("function");
  });
});
