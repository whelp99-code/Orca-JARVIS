import { describe, expect, it } from "vitest";
import {
  assembleModelRequest, assemblePersonalContext, RecordingModelTransport, sendAssembledModelRequest,
} from "../../src/index.js";
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
      budgets: { max_items: 16, max_excerpt_bytes: 3500, max_total_bytes: 8000 },
      memories: [
        { ...base, memory_ref: "sid:principle:a", excerpt: "a".repeat(2400) },
        { ...base, memory_ref: "sid:principle:b", excerpt: "b".repeat(2400) },
      ],
    };
    const request = assembleModelRequest(oversized);
    expect(Buffer.byteLength(JSON.stringify(request), "utf8")).toBeLessThanOrEqual(8000);
    expect(request.used_bytes).toBeLessThanOrEqual(8000);
  });

  it("records pre-send JSON on an isolated transport for a new session", async () => {
    const transport = new RecordingModelTransport();
    const accepted = await sendAssembledModelRequest(contextAssemblerInput(), "session:new", transport);
    expect(accepted).toEqual({ accepted: true });
    expect(transport.sent).toHaveLength(1);
    const capture = transport.sent[0];
    expect(capture?.session_id).toBe("session:new");
    expect(capture?.json).toContain("what now?");
    expect(capture?.json).toContain("Prioritize confirmed customer");
    expect(capture?.json).toContain("src:pos:v1:second-brain:primary");
    expect(capture?.json).toMatch(/sha256:[0-9a-f]{64}/);
    expect(capture?.bytes).toBe(Buffer.byteLength(capture?.json ?? "", "utf8"));
    expect(capture?.bytes).toBeLessThanOrEqual(4096);
    expect(capture?.no_data).toBe(false);
  });

  it("omits untrusted memories and reports no_data when nothing is deliverable", async () => {
    const input = contextAssemblerInput() as { memories: Array<Record<string, unknown>> };
    const base = input.memories[0] ?? {};
    const transport = new RecordingModelTransport();
    await sendAssembledModelRequest({
      ...contextAssemblerInput(),
      memories: [{ ...base, trust: "untrusted" }],
    }, "session:empty", transport);
    expect(transport.sent[0]?.no_data).toBe(true);
    expect(transport.sent[0]?.json).not.toContain("Prioritize confirmed customer");
  });

  it("omits stale memories after clock passes fresh_until", async () => {
    const transport = new RecordingModelTransport();
    await sendAssembledModelRequest({ ...contextAssemblerInput(), clock: "2026-08-28T13:30:00.000Z" }, "session:stale", transport);
    expect(transport.sent[0]?.json).not.toContain("Prioritize confirmed customer");
    expect(transport.sent[0]?.no_data).toBe(true);
    expect(JSON.stringify(transport.sent[0]?.request.omitted ?? [])).toMatch(/STALE_MEMORY|MEMORY_REQUIRED/);
  });

  it("keeps no_data gaps out of the pre-send body", async () => {
    const transport = new RecordingModelTransport();
    await sendAssembledModelRequest({
      ...contextAssemblerInput(),
      memories: [{ kind: "gap", memory_ref: "sid:missing", state: "no_data" }],
    }, "session:gap", transport);
    expect(transport.sent[0]?.no_data).toBe(true);
    expect(transport.sent[0]?.request.memories).toEqual([]);
  });
});
