import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  assemblePersonalContext,
  canonicalize,
  canonicalPersonalContractJson,
  CONTEXT_ASSEMBLER_BUDGET_IMPOSSIBLE,
} from "../../src/index.js";
import { contextAssemblerInput } from "../fixtures/context-assembler-input.js";

function itemCount(snapshot: ReturnType<typeof assemblePersonalContext>): number {
  const payload = snapshot.payload;
  return payload.included_observation_refs.length + payload.included_memory_refs.length
    + payload.excluded_refs.length + payload.pending_authority_refs.length
    + payload.conflicts.length + payload.omissions.length;
}
function principle(): Readonly<Record<string, unknown>> {
  const memories = contextAssemblerInput()["memories"];
  if (!Array.isArray(memories) || typeof memories[0] !== "object" || memories[0] === null) {
    throw new TypeError("memory fixture required");
  }
  return memories[0];
}
function overflowToken(snapshot: ReturnType<typeof assemblePersonalContext>): string {
  const found = snapshot.payload.omissions.find(item => item.startsWith("BUDGET_OVERFLOW:"));
  if (found === undefined) throw new TypeError("overflow token required");
  return found;
}
function expectedOverflow(omittedRefs: readonly string[]): string {
  const manifest = omittedRefs.map(reference => ({ category: "memory", reference }));
  const digest = createHash("sha256").update(canonicalize(manifest)).digest("hex").slice(0, 8);
  return `BUDGET_OVERFLOW:${digest}`;
}

describe("Task 15 exact context budgets", () => {
  it("throws the typed budget error when the minimum full canonical snapshot cannot fit", () => {
    // Given: a cap below the minimum valid envelope and evidence size.
    const input = { ...contextAssemblerInput(), budgets: { max_items: 16, max_excerpt_bytes: 128, max_total_bytes: 1_200 } };
    // When: assembly either rejects or exposes the currently oversized snapshot.
    try {
      const snapshot = assemblePersonalContext(input);
      // Then: returning a snapshot over the declared full-byte cap is forbidden.
      expect(Buffer.byteLength(canonicalPersonalContractJson(snapshot), "utf8")).toBeLessThanOrEqual(1_200);
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      expect(error).toMatchObject({ code: CONTEXT_ASSEMBLER_BUDGET_IMPOSSIBLE });
    }
  });

  it("selects an exact 32-byte excerpt and excludes the original 33-byte source", () => {
    // Given: related confirmed memories exactly at and one byte over the UTF-8 cap.
    const source = principle();
    const memories = [
      { ...source, memory_ref: "sid:excerpt:32", digest: `sha256:${"b".repeat(64)}`, excerpt: "x".repeat(32) },
      { ...source, memory_ref: "sid:excerpt:33", digest: `sha256:${"c".repeat(64)}`, excerpt: "x".repeat(33) },
    ];
    // When: a feasible bounded context is assembled.
    const snapshot = assemblePersonalContext({
      ...contextAssemblerInput(), budgets: { max_items: 16, max_excerpt_bytes: 32, max_total_bytes: 4_096 }, memories,
    });
    // Then: exact-boundary data is selected and over-cap provenance is explicitly excluded.
    expect(snapshot.payload.included_memory_refs).toContain("sid:excerpt:32");
    expect(snapshot.payload.included_memory_refs).not.toContain("sid:excerpt:33");
    expect(snapshot.payload.excluded_refs).toContain("sid:excerpt:33");
    expect(snapshot.payload.omissions.some(item => item.startsWith("EXCERPT_OVER_CAP:"))).toBe(true);
  });

  it("binds overflow digests to the exact omitted source manifest", () => {
    // Given: same-category overflow sets that differ only in exact source identities.
    const source = principle();
    const memories = (prefix: string) => Array.from({ length: 9 }, (_, index) => ({
      ...source, memory_ref: `sid:${prefix}:${index}`, digest: `sha256:${index.toString(16).repeat(64)}`,
    }));
    const build = (prefix: string) => assemblePersonalContext({
      ...contextAssemblerInput(), budgets: { max_items: 6, max_excerpt_bytes: 128, max_total_bytes: 4_096 }, memories: memories(prefix),
    });
    // When: both bounded snapshots are assembled.
    const left = build("left");
    const right = build("right");
    // Then: item/full-byte caps hold and each token reproduces its exact omitted manifest.
    for (const [prefix, snapshot] of [["left", left], ["right", right]] as const) {
      const omitted = memories(prefix).map(item => item.memory_ref)
        .filter(reference => !snapshot.payload.included_memory_refs.includes(reference));
      expect(itemCount(snapshot)).toBeLessThanOrEqual(6);
      expect(Buffer.byteLength(canonicalPersonalContractJson(snapshot), "utf8")).toBeLessThanOrEqual(4_096);
      expect(overflowToken(snapshot)).toBe(expectedOverflow(omitted));
    }
    expect(overflowToken(left)).not.toBe(overflowToken(right));
  });
});
