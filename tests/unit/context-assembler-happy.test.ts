import { describe, expect, it } from "vitest";
import {
  assemblePersonalContext,
  canonicalPersonalContractHash,
  canonicalPersonalContractJson,
  parseContextSnapshotV1,
} from "../../src/index.js";
import { contextAssemblerInput } from "../fixtures/context-assembler-input.js";

describe("Task 15 happy deterministic assembly", () => {
  it("builds a sufficient cited snapshot from fresh Linux work and confirmed memory", () => {
    // Given: fresh Linux TaskTimeline evidence, pending authority, and a confirmed priority memory.
    const input = contextAssemblerInput();
    // When: the public assembler output is checked at the frozen contract boundary.
    const snapshot = parseContextSnapshotV1(assemblePersonalContext(input));
    // Then: every selected source is cited and the envelope is sufficient and expiring.
    expect(snapshot.payload).toMatchObject({
      purpose: "daily_prioritization",
      query: "what now?",
      state: "sufficient",
      included_memory_refs: ["sid:principle:customer-first"],
      pending_authority_refs: ["request:owner:deploy"],
      conflicts: [],
      omissions: [],
    });
    expect(snapshot.payload.included_observation_refs).toHaveLength(1);
    expect(snapshot.evidence).toHaveLength(2);
    expect(snapshot.expires_at).toBe("2026-08-28T12:04:00.000Z");
    expect(canonicalPersonalContractHash(snapshot)).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("returns byte-identical canonical output for identical input and clock", () => {
    // Given: two independently allocated copies of the same validated source values.
    const left = contextAssemblerInput();
    const right = structuredClone(contextAssemblerInput());
    // When: both snapshots are assembled.
    const first = assemblePersonalContext(left);
    const second = assemblePersonalContext(right);
    // Then: deterministic identity and canonical bytes are equal.
    expect(second.id).toBe(first.id);
    expect(canonicalPersonalContractJson(second)).toBe(canonicalPersonalContractJson(first));
  });
});
