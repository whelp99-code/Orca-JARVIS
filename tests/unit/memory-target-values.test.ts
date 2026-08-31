import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { memoryExpectedPrior, memoryTargetManifestDigest, memoryTargetScopeDigest, sameMemoryGeneration } from "../../src/memory-target-values.js";
import type { MemoryEffectWriteRequestV2 } from "../../src/second-brain-effect-v2.js";

const request = ((JSON.parse(readFileSync("contracts/second-brain-mcp-v1.json", "utf8")) as {
  readonly vectors: { readonly correction: { readonly request: MemoryEffectWriteRequestV2 } };
}).vectors.correction.request);
function fixture<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("MEMORY_FIXTURE_INVALID");
  return value;
}
const target = fixture(request.targets[0]);

describe("resolved memory targets", () => {
  it("binds complete target objects, exact scope, and expected prior", () => {
    expect(memoryTargetManifestDigest(request.targets)).toBe(request.target_manifest_digest);
    expect(memoryTargetScopeDigest(request.targets, request.scope)).toBe(request.scope_digest);
    expect(sameMemoryGeneration(request.targets)).toBe(true);
    expect(memoryExpectedPrior(target)).toEqual(request.expected_prior);
  });

  it("rejects mixed generations before target authority construction", () => {
    const mixed = [target, { ...target, generation_id: `sbgen:v1:${"f".repeat(64)}` }];
    expect(sameMemoryGeneration(mixed)).toBe(false);
  });
});
