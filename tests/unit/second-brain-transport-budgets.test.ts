import { afterEach, describe, expect, it } from "vitest";
import { createSecondBrainTransport } from "../../src/second-brain-transport.js";
import { ManualTimers, fixture, options, receiptSignal, release } from "../fixtures/second-brain-transport-harness.js";

const transports: Array<{ close(): Promise<void> }> = [];
afterEach(async () => { await Promise.all(transports.splice(0).map(item => item.close())); });

describe("Second Brain correlation and budgets", () => {
  it("correlates out-of-order reads while admitting four and removes a cancelled queued read", async () => {
    const value = fixture(); const transport = createSecondBrainTransport(options(value)); transports.push(transport);
    const calls = Array.from({ length: 5 }, (_, index) => transport.call("sb_search", { query: String(index), hold: true }));
    const rows = await receiptSignal(value.receipt, 4); expect(rows).toHaveLength(4); expect(transport.diagnostics().filter(item => item.code === "SECOND_BRAIN_REQUESTED" && item.method === "sb_search")).toHaveLength(4);
    const queued = new AbortController(); const cancelled = transport.call("sb_search", { query: "cancelled", hold: true }, { signal: queued.signal }); queued.abort();
    await expect(cancelled).rejects.toMatchObject({ code: "SECOND_BRAIN_CANCELLED", disposition: "cancelled" });
    release(value.control); const dispatched = await receiptSignal(value.receipt, 5); release(value.control);
    const correlated = await Promise.all(calls); expect(correlated).toMatchObject(Array.from({ length: 5 }, (_, index) => ({ value: { results: [{ snippet: String(index) }] } })));
    expect(dispatched.map(row => row.name)).toEqual(Array(5).fill("sb_search"));
  });

  it("serializes writes and marks in-flight cancellation once", async () => {
    const value = fixture(); const transport = createSecondBrainTransport(options(value)); transports.push(transport);
    const first = transport.call("sb_remember", { content: "one", hold: true }); const second = transport.call("sb_remember", { content: "two", hold: true });
    await expect(receiptSignal(value.receipt, 1)).resolves.toHaveLength(1); expect(transport.diagnostics().filter(item => item.code === "SECOND_BRAIN_REQUESTED" && item.method === "sb_remember")).toHaveLength(1);
    const controller = new AbortController(); const cancelled = transport.call("sb_remember", { content: "three", hold: true }, { signal: controller.signal }); controller.abort();
    await expect(cancelled).rejects.toMatchObject({ code: "SECOND_BRAIN_CANCELLED", disposition: "cancelled" });
    release(value.control); await expect(first).resolves.toMatchObject({ kind: "data" });
    await expect(receiptSignal(value.receipt, 2)).resolves.toHaveLength(2); release(value.control); await expect(second).resolves.toMatchObject({ kind: "data" });
    expect((await receiptSignal(value.receipt, 2)).filter(row => row.name === "sb_remember")).toHaveLength(2);
  });

  it("cancels an in-flight request once and accepts its bounded late response", async () => {
    const value = fixture(); const transport = createSecondBrainTransport(options(value)); transports.push(transport); const controller = new AbortController();
    const pending = transport.call("sb_search", { query: "cancel", hold: true }, { signal: controller.signal }); await receiptSignal(value.receipt, 1); controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "SECOND_BRAIN_CANCELLED", disposition: "cancelled" }); release(value.control);
    await expect(transport.call("sb_search", { query: "after" })).resolves.toMatchObject({ kind: "data" }); expect(transport.diagnostics().some(item => item.code === "SECOND_BRAIN_UNMATCHED_FRAME")).toBe(false);
  });

  it("uses machine-visible startup/read/write deadlines and clears typed timers", async () => {
    const value = fixture(); const timers = new ManualTimers(); const transport = createSecondBrainTransport(options(value, { timers })); transports.push(transport);
    await expect(transport.call("sb_search", { query: "ready" })).resolves.toMatchObject({ kind: "data" });
    const read = transport.call("sb_search", { query: "hang", hang: true }); await receiptSignal(value.receipt, 2); timers.fireLatest(); await expect(read).rejects.toMatchObject({ code: "SECOND_BRAIN_READ_TIMEOUT", disposition: "unavailable" });
    const write = transport.call("sb_remember", { content: "hang", hang: true }); await receiptSignal(value.receipt, 3); timers.fireLatest(); await expect(write).rejects.toMatchObject({ code: "SECOND_BRAIN_WRITE_TIMEOUT", disposition: "uncertain" });
    expect(timers.delays).toEqual(expect.arrayContaining([5_000, 10_000, 30_000])); expect(timers.count).toBe(0);
  });

  it("parses no_data, rejects unknown and duplicate IDs, and emits redacted diagnostics", async () => {
    const empty = fixture(); const transport = createSecondBrainTransport(options(empty)); transports.push(transport);
    await expect(transport.call("sb_search", { query: "secret-token", empty: true })).resolves.toEqual({ kind: "no_data", reason: "empty_result" });
    for (const args of [{ unmatched: true }, { duplicate: true }] as const) { const value = fixture(); const client = createSecondBrainTransport(options(value)); transports.push(client); const result = client.call("sb_search", { query: "authorization=abc", ...args }); if (args.unmatched) await expect(result).rejects.toMatchObject({ code: "SECOND_BRAIN_UNMATCHED_FRAME" }); else { await expect(result).resolves.toMatchObject({ kind: "data" }); expect(client.diagnostics().some(item => item.code === "SECOND_BRAIN_DUPLICATE_FRAME")).toBe(true); } expect(client.diagnostics().every(item => !/secret|authorization|abc/i.test(JSON.stringify(item)))).toBe(true); }
  });
});
