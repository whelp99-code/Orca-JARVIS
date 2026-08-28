import { execFile, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { createSecondBrainTransport } from "../../src/second-brain-transport.js";
import { ManualTimers, cleanupFixtures, fixture, options, receiptSignal, release } from "../fixtures/second-brain-transport-harness.js";

const transports: Array<{ close(): Promise<void> }> = [];
afterEach(async () => { await Promise.all(transports.splice(0).map(item => item.close())); cleanupFixtures(); });

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

  it("rejects an outbound frame over one MiB before writing stdin", async () => {
    // Given: a ready executable fixture with an empty call receipt.
    const value = fixture(); const transport = createSecondBrainTransport(options(value)); transports.push(transport);
    await expect(transport.call("sb_search", { query: "ready" })).resolves.toMatchObject({ kind: "data" });
    const before = readFileSync(value.receipt, "utf8");
    // When: a serialized request exceeds the frame budget.
    const oversized = transport.call("sb_search", { query: "x".repeat(1_048_576) });
    // Then: the typed rejection occurs without a child receipt.
    await expect(oversized).rejects.toMatchObject({ code: "SECOND_BRAIN_OVERSIZE_FRAME", disposition: "fatal" });
    expect(readFileSync(value.receipt, "utf8")).toBe(before);
  });

  it("accepts two sub-limit response frames coalesced in one stdout chunk", async () => {
    // Given: two legal responses whose aggregate exceeds one MiB.
    const value = fixture(); let child: ChildProcess | undefined;
    const transport = createSecondBrainTransport(options(value, { execFile: (file, args, childOptions) => { child = execFile(file, [...args], childOptions); return child; } })); transports.push(transport);
    const first = transport.call("sb_search", { query: "one", hold: true }); const second = transport.call("sb_search", { query: "two", hold: true });
    await receiptSignal(value.receipt, 2);
    const ids = transport.diagnostics().filter(item => item.code === "SECOND_BRAIN_REQUESTED").map(item => item.request_id).filter((id): id is string => typeof id === "string");
    const frames = ids.map(id => JSON.stringify({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify({ results: [{ snippet: "r".repeat(600_000) }] }) }], isError: false } })).join("\n");
    // When: one data event carries both newline-delimited frames.
    child?.stdout?.emit("data", Buffer.from(`${frames}\n`));
    // Then: each complete frame is capped independently.
    await expect(Promise.all([first, second])).resolves.toMatchObject([{ kind: "data" }, { kind: "data" }]);
  });

  it("discards one bounded late timeout response without corrupting healthy work", async () => {
    // Given: request A has timed out while request B remains in flight.
    const value = fixture({ releaseForward: true }); const timers = new ManualTimers(); const transport = createSecondBrainTransport(options(value, { timers })); transports.push(transport);
    await expect(transport.call("sb_search", { query: "ready" })).resolves.toMatchObject({ kind: "data" });
    const late = transport.call("sb_search", { query: "late", hold: true }); await receiptSignal(value.receipt, 2); timers.fire(10_000);
    await expect(late).rejects.toMatchObject({ code: "SECOND_BRAIN_READ_TIMEOUT" });
    const healthy = transport.call("sb_search", { query: "healthy", hold: true }); await receiptSignal(value.receipt, 3);
    // When: A's late response arrives before B's response.
    release(value.control);
    // Then: B and a later request complete in the same healthy generation.
    await expect(healthy).resolves.toMatchObject({ kind: "data" });
    await expect(transport.call("sb_search", { query: "later" })).resolves.toMatchObject({ kind: "data" });
    expect(transport.diagnostics().filter(item => item.code === "SECOND_BRAIN_STARTED")).toHaveLength(1);
  });

  it("bounds newline-free stderr retention while reporting redacted byte metadata", async () => {
    // Given: a diagnostic subscription installed before a large newline-free stderr write.
    const value = fixture(); let timeout: ReturnType<typeof setTimeout> | undefined; let resolveDiagnostic: ((value: unknown) => void) | undefined;
    const diagnostic = new Promise<unknown>((resolve, reject) => { timeout = setTimeout(() => reject(new Error("stderr diagnostic missing")), 2_000); resolveDiagnostic = value => { if (timeout) clearTimeout(timeout); resolve(value); }; });
    const transport = createSecondBrainTransport(options(value, { onDiagnostic: item => { if (item.code === "SECOND_BRAIN_STDERR" && item.stderr_bytes === 65_536) resolveDiagnostic?.(item); } })); transports.push(transport);
    // When: the child emits two MiB without a delimiter.
    await expect(transport.call("sb_search", { query: "stderr", stderrBytes: 2_097_152 })).resolves.toMatchObject({ kind: "data" });
    // Then: retained raw bytes remain bounded and only numeric metadata is exposed.
    await expect(diagnostic).resolves.toMatchObject({ code: "SECOND_BRAIN_STDERR", stderr_bytes: 65_536, stderr_buffer_bytes: 4_096 });
    expect(JSON.stringify(transport.diagnostics())).not.toContain("ssssssss");
  });

  it("parses no_data, rejects unknown and duplicate IDs, and emits redacted diagnostics", async () => {
    const empty = fixture(); const transport = createSecondBrainTransport(options(empty)); transports.push(transport);
    await expect(transport.call("sb_search", { query: "secret-token", empty: true })).resolves.toEqual({ kind: "no_data", reason: "empty_result" });
    for (const args of [{ unmatched: true }, { duplicate: true }] as const) { const value = fixture(); const client = createSecondBrainTransport(options(value)); transports.push(client); const result = client.call("sb_search", { query: "authorization=abc", ...args }); if (args.unmatched) await expect(result).rejects.toMatchObject({ code: "SECOND_BRAIN_UNMATCHED_FRAME" }); else { await expect(result).resolves.toMatchObject({ kind: "data" }); expect(client.diagnostics().some(item => item.code === "SECOND_BRAIN_DUPLICATE_FRAME")).toBe(true); } expect(client.diagnostics().every(item => !/secret|authorization|abc/i.test(JSON.stringify(item)))).toBe(true); }
  });
});
