import { describe, expect, it } from "vitest";
import { assembleModelRequest, assemblePersonalContext } from "../../src/index.js";
import { contextAssemblerInput } from "../fixtures/context-assembler-input.js";

describe("model request delivery from assembled context", () => {
  it("puts confirmed memory body, source, version, and remaining budget on the request", () => {
    const input = contextAssemblerInput();
    const snapshot = assemblePersonalContext(input);
    const request = assembleModelRequest(input);
    expect(snapshot.payload.included_memory_refs).toContain("sid:principle:customer-first");
    expect(JSON.stringify(snapshot).includes("Prioritize confirmed customer")).toBe(false);
    const delivered = request.memories.find((item) => item.memory_ref === "sid:principle:customer-first");
    expect(delivered?.excerpt).toContain("Prioritize confirmed customer");
    expect(delivered?.source_id).toBe("src:pos:v1:second-brain:primary");
    expect(delivered?.version).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(request.remaining_bytes).toBe(request.budgets.max_total_bytes - request.used_bytes);
  });

  it("counts query bytes so two 2400-byte excerpts plus a 3500-byte query stay under 8000", () => {
    const input = contextAssemblerInput() as { memories: Array<Record<string, unknown>> };
    const base = input.memories[0] ?? {};
    const oversized = {
      ...contextAssemblerInput(),
      query: "q".repeat(3500),
      budgets: { max_items: 16, max_excerpt_bytes: 2400, max_total_bytes: 8000 },
      memories: [
        { ...base, memory_ref: "sid:a", excerpt: "a".repeat(2400) },
        { ...base, memory_ref: "sid:b", excerpt: "b".repeat(2400) },
      ],
    };
    const request = assembleModelRequest(oversized);
    expect(Buffer.byteLength(JSON.stringify(request), "utf8")).toBeLessThanOrEqual(8000);
    expect(request.used_bytes).toBeLessThanOrEqual(8000);
  });
});
