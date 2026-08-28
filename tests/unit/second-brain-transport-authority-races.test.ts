import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { createSecondBrainTransport, type SecondBrainDiagnostic, type SecondBrainMethod } from "../../src/second-brain-transport.js";
import { cleanupFixtures, fixture, options, receiptSignal, release } from "../fixtures/second-brain-transport-harness.js";

const contract: unknown = JSON.parse(readFileSync("contracts/second-brain-mcp-v1.json", "utf8"));
const transports: Array<{ close(): Promise<void> }> = [];
afterEach(async () => { await Promise.allSettled(transports.splice(0).map(item => item.close())); cleanupFixtures(); });

function producerTools(): Array<Record<string, unknown>> {
  if (!isRecord(contract) || !isRecord(contract.tools)) return [];
  return Object.entries(contract.tools).flatMap(([name, tool]) => { if (!isRecord(tool) || !isRecord(tool.arguments)) return []; const inputSchema = structuredClone(tool.arguments); delete inputSchema.additionalProperties; return [{ name, inputSchema }]; });
}
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }

function diagnosticSignal(match: (item: SecondBrainDiagnostic) => boolean): { readonly wait: Promise<void>; readonly receive: (item: SecondBrainDiagnostic) => void } {
  let receiveMatch: (() => void) | undefined; const wait = new Promise<void>(resolve => { receiveMatch = resolve; });
  return { wait, receive: item => { if (match(item)) receiveMatch?.(); } };
}

describe("Second Brain transport authority races", () => {
  it("keeps cancellation authority across shared startup in both read/write directions", async () => {
    const cases: ReadonlyArray<readonly [SecondBrainMethod, Record<string, unknown>, SecondBrainMethod, Record<string, unknown>]> = [
      ["sb_search", { query: "cancelled" }, "sb_remember", { content: "survives" }],
      ["sb_remember", { content: "cancelled" }, "sb_search", { query: "survives" }],
    ];
    for (const [cancelMethod, cancelArgs, liveMethod, liveArgs] of cases) {
      const startup = diagnosticSignal(item => item.code === "SECOND_BRAIN_STDERR"); const value = fixture({ mode: "hold-tools" }); const transport = createSecondBrainTransport(options(value, { onDiagnostic: startup.receive })); transports.push(transport); const controller = new AbortController();
      const cancelled = transport.call(cancelMethod, cancelArgs, { signal: controller.signal }); const live = transport.call(liveMethod, liveArgs); await startup.wait; controller.abort(); release(value.control);
      await expect(cancelled).rejects.toMatchObject({ code: "SECOND_BRAIN_CANCELLED", disposition: "cancelled" }); await expect(live).resolves.toMatchObject({ kind: "data" }); const calls = (await receiptSignal(value.receipt, 1)).filter(row => row.event === "call"); expect(calls).toHaveLength(1); expect(calls[0]?.name).toBe(liveMethod);
    }
  });

  it("classifies synchronous requested-diagnostic write abort as dispatched uncertainty", async () => {
    const value = fixture({ wireReceipts: true }); const controller = new AbortController(); const order: string[] = []; const transport = createSecondBrainTransport(options(value, { onDiagnostic: item => { if (item.code === "SECOND_BRAIN_REQUESTED" && item.method === "sb_remember") { order.push("requested"); controller.abort(); order.push("aborted"); } } })); transports.push(transport);
    await expect(transport.call("sb_search", { query: "ready" })).resolves.toMatchObject({ kind: "data" }); await expect(transport.call("sb_remember", { content: "once" }, { signal: controller.signal })).rejects.toMatchObject({ code: "SECOND_BRAIN_WRITE_INTERRUPTED", disposition: "uncertain", generation: 1, request_id: "1:4" });
    const rows = await receiptSignal(value.receipt, 3); const calls = rows.filter(row => row.name === "sb_remember"); const wire = rows.filter(row => row.event === "frame").map(row => row.method); expect(calls).toHaveLength(1); expect(wire.slice(-2)).toEqual(["tools/call", "notifications/cancelled"]); expect(order).toEqual(["requested", "aborted"]);
    const prewrite = new AbortController(); prewrite.abort(); const receiptBefore = readFileSync(value.receipt, "utf8"); const diagnosticsBefore = transport.diagnostics().filter(item => item.method === "sb_remember").length; await expect(transport.call("sb_remember", { content: "never" }, { signal: prewrite.signal })).rejects.toMatchObject({ code: "SECOND_BRAIN_CANCELLED", disposition: "cancelled" }); expect(readFileSync(value.receipt, "utf8")).toBe(receiptBefore); expect(transport.diagnostics().filter(item => item.method === "sb_remember")).toHaveLength(diagnosticsBefore);
  });

  it("snapshots only plain own enumerable data arguments once", async () => {
    const value = fixture({ tools: producerTools() }); const transport = createSecondBrainTransport(options(value)); transports.push(transport); await expect(transport.call("sb_search", { query: "ready" })).resolves.toMatchObject({ kind: "data" }); const mutable = { query: "original" }; const snapshotted = transport.call("sb_search", mutable); mutable.query = "changed"; await expect(snapshotted).resolves.toMatchObject({ value: { results: [{ snippet: "original" }] } }); let getterCalls = 0;
    const inherited: Record<string, unknown> = Object.create({ query: "inherited" });
    class CustomArguments { readonly [key: string]: unknown; readonly query = "class"; }
    const accessor: Record<string, unknown> = {}; Object.defineProperty(accessor, "query", { enumerable: true, get: () => { getterCalls += 1; return "getter"; } });
    const hidden: Record<string, unknown> = {}; Object.defineProperty(hidden, "query", { enumerable: false, value: "hidden" });
    const withSymbol: Record<string | symbol, unknown> = { query: "symbol" }; withSymbol[Symbol("x")] = true;
    const withToJson: Record<string, unknown> = { query: "json", toJSON: () => ({ query: "changed" }) };
    const proxy = new Proxy<Record<string, unknown>>({ query: "proxy" }, { ownKeys: () => ["query", "extra"] });
    for (const hostile of [inherited, new CustomArguments(), accessor, hidden, withSymbol, withToJson]) await expect(transport.call("sb_search", hostile)).rejects.toMatchObject({ code: "SECOND_BRAIN_INVALID_ARGUMENTS" });
    await expect(transport.call("sb_search", proxy)).resolves.toMatchObject({ value: { results: [{ snippet: "proxy" }] } }); expect(getterCalls).toBe(0); expect(readFileSync(value.receipt, "utf8").split("\n").filter(Boolean)).toHaveLength(3);
  });
});
