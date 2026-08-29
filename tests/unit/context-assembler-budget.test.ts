import { describe, expect, it } from "vitest";
import { assemblePersonalContext, canonicalize } from "../../src/index.js";
import { contextAssemblerInput } from "../fixtures/context-assembler-input.js";

function itemCount(snapshot: ReturnType<typeof assemblePersonalContext>): number {
  const payload = snapshot.payload;
  return payload.included_observation_refs.length + payload.included_memory_refs.length
    + payload.excluded_refs.length + payload.pending_authority_refs.length
    + payload.conflicts.length + payload.omissions.length;
}

describe("Task 15 exact context budgets", () => {
  it("deterministically bounds UTF-8 excerpts, item count, and serialized payload bytes", () => {
    // Given: multibyte oversized source data and more eligible memories than the caps permit.
    const base = contextAssemblerInput();
    const primary = base["memories"];
    if (!Array.isArray(primary)) throw new TypeError("memory fixture required");
    const memories = [
      { ...primary[0], excerpt: "界".repeat(100) },
      ...Array.from({ length: 8 }, (_, index) => ({
        ...primary[0],
        memory_ref: `sid:principle:overflow-${index}`,
        digest: `sha256:${index.toString(16).repeat(64)}`,
      })),
    ];
    const input = { ...base, budgets: { max_items: 6, max_excerpt_bytes: 32, max_total_bytes: 1_200 }, memories };
    // When: the bounded snapshot is assembled twice.
    const first = assemblePersonalContext(input);
    const second = assemblePersonalContext(structuredClone(input));
    // Then: exact configured caps hold and overflow/truncation are machine-visible.
    expect(itemCount(first)).toBeLessThanOrEqual(6);
    expect(Buffer.byteLength(canonicalize(first.payload), "utf8")).toBeLessThanOrEqual(1_200);
    expect([first.payload.query, ...first.payload.conflicts, ...first.payload.omissions]
      .every(item => Buffer.byteLength(item, "utf8") <= 32)).toBe(true);
    expect(first.payload.omissions.some(item => item.startsWith("EXCERPT_TRUNCATED:"))).toBe(true);
    expect(first.payload.omissions.some(item => item.startsWith("BUDGET_OVERFLOW:"))).toBe(true);
    expect(canonicalize(second)).toBe(canonicalize(first));
  });
});
