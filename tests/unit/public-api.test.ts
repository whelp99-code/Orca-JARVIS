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

  it("keeps shadow evolution internals private while preserving proposal helpers", () => {
    const shadowInternals = [
      "BudgetedEvolutionEngine",
      "EvolutionShadowRuntime",
      "SqlitePerformanceMemory",
    ] as const;

    expect(shadowInternals.filter(name => name in publicApi)).toEqual([]);
    expect(typeof publicApi.buildCapabilityMatrix).toBe("function");
    expect(typeof publicApi.planTeamProposal).toBe("function");
    expect(typeof publicApi.createSecondBrainTransport).toBe("function");
    expect(typeof publicApi.createSecondBrainReadAdapter).toBe("function");
    expect(typeof publicApi.MemoryOutboxService).toBe("function");
    expect(publicApi.MEMORY_OUTBOX_RUNTIME_DEADLINE_MS).toBe(600_000);
  });
});
