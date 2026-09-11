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
});
