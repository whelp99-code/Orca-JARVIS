import { execFile, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { readFileSync, writeFileSync } from "node:fs";
import { PassThrough, Writable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { createSecondBrainTransport, type SecondBrainExecFile } from "../../src/second-brain-transport.js";
import { ManualTimers, cleanupFixtures, fixture, forceKill, options, receiptSignal } from "../fixtures/second-brain-transport-harness.js";

const contract = JSON.parse(readFileSync("contracts/second-brain-mcp-v1.json", "utf8")) as { tools: Record<string, { arguments: unknown }> };
class SignalProcess extends EventEmitter {
  readonly stdout = new PassThrough(); readonly stderr = new PassThrough(); readonly stdin: Writable; exitCode: number | null = null; signalCode: NodeJS.Signals | null = null; readonly signals: NodeJS.Signals[] = [];
  constructor(private readonly killResult: boolean, private readonly holdCalls = false, private readonly closeOnKill = false) { super(); this.stdin = new Writable({ write: (chunk, _encoding, done) => { for (const line of chunk.toString().trim().split("\n")) { const message = JSON.parse(line) as { id?: string; method?: string }; if (!message.id || (message.method === "tools/call" && this.holdCalls)) continue; const result = message.method === "initialize" ? { protocolVersion: "2026-07-28", serverInfo: { name: "second-brain", version: "1" } } : message.method === "tools/list" ? { tools: Object.entries(contract.tools).map(([name, tool]) => ({ name, inputSchema: tool.arguments })) } : { content: [{ type: "text", text: "{\"results\":[]}" }], isError: false }; queueMicrotask(() => this.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result })}\n`)); } done(); } }); }
  kill(signal?: NodeJS.Signals | number): boolean { if (typeof signal === "string") this.signals.push(signal); if (this.closeOnKill) queueMicrotask(() => this.emit("close")); return this.killResult; }
}

const transports: Array<{ close(): Promise<void> }> = [];
afterEach(async () => { await Promise.allSettled(transports.splice(0).map(item => item.close())); cleanupFixtures(); });

describe("Second Brain crash and uncertainty", () => {
  it("restarts in a new generation and retries a known-safe read once", async () => {
    const value = fixture(); const transport = createSecondBrainTransport(options(value, { safeReadRetries: 1 })); transports.push(transport);
    await expect(transport.call("sb_search", { query: "safe", crashOnce: true })).resolves.toMatchObject({ kind: "data" });
    expect((await receiptSignal(value.receipt, 2)).filter(row => row.name === "sb_search")).toHaveLength(2);
    expect(transport.diagnostics().filter(item => item.code === "SECOND_BRAIN_STARTED").map(item => item.generation)).toEqual([1, 2]);
  });

  it("settles every old-generation pending request exactly once on child exit", async () => {
    const value = fixture(); const transport = createSecondBrainTransport(options(value, { safeReadRetries: 0 })); transports.push(transport);
    const first = transport.call("sb_search", { query: "one", hold: true }); const second = transport.call("sb_recent_changes", { hold: true });
    await receiptSignal(value.receipt, 2); const crash = transport.call("sb_open_conflicts", { crash: true });
    const settled = await Promise.allSettled([first, second, crash]); expect(settled).toHaveLength(3); expect(settled.every(item => item.status === "rejected")).toBe(true);
    expect(transport.diagnostics().filter(item => item.code === "SECOND_BRAIN_CHILD_EXIT")).toHaveLength(1);
  });

  it("marks a dispatched write uncertain and never replays it automatically", async () => {
    const value = fixture(); const transport = createSecondBrainTransport(options(value)); transports.push(transport);
    await expect(transport.call("sb_remember", { content: "once", crash: true })).rejects.toMatchObject({ code: "SECOND_BRAIN_WRITE_INTERRUPTED", disposition: "uncertain", generation: 1 });
    const writes = (await receiptSignal(value.receipt, 1)).filter(row => row.name === "sb_remember"); expect(writes).toHaveLength(1);
    await expect(transport.call("sb_search", { query: "restart" })).resolves.toMatchObject({ kind: "data" });
    expect((await receiptSignal(value.receipt, 2)).filter(row => row.name === "sb_remember")).toHaveLength(1);
  });

  it("surfaces restart handshake failure without reviving old work", async () => {
    const value = fixture(); const transport = createSecondBrainTransport(options(value, { safeReadRetries: 1 })); transports.push(transport);
    const failed = transport.call("sb_search", { query: "crash", crash: true }); await receiptSignal(value.receipt, 1);
    writeFileSync(value.config, JSON.stringify({ protocolVersion: "wrong", control: value.control, receipt: value.receipt }));
    await expect(failed).rejects.toMatchObject({ code: "SECOND_BRAIN_VERSION_MISMATCH" });
    expect((await receiptSignal(value.receipt, 1)).filter(row => row.name === "sb_search")).toHaveLength(1);
  });

  it("escalates an ignored SIGTERM within the injected shutdown budget and settles once", async () => {
    // Given: a handshaken real child that records and ignores SIGTERM.
    const value = fixture({ ignoreTerm: true }); const timers = new ManualTimers(); const signals: Array<NodeJS.Signals | number | undefined> = [];
    const runner: SecondBrainExecFile = (file, args, childOptions) => {
      const child = execFile(file, [...args], childOptions); return new Proxy<ChildProcess>(child, { get: (target, property, receiver) => property === "kill" ? (signal?: NodeJS.Signals | number) => { signals.push(signal); return target.kill(signal); } : Reflect.get(target, property, receiver) });
    };
    const transport = createSecondBrainTransport(options(value, { execFile: runner, timers })); transports.push(transport);
    await expect(transport.call("sb_search", { query: "ready" })).resolves.toMatchObject({ kind: "data" });
    // When: two callers close concurrently after the signal observer is installed.
    const first = transport.close(); const second = transport.close();
    if (!timers.delays.includes(1_000)) forceKill(value.control);
    expect(signals).toEqual(["SIGTERM"]); expect(timers.delays).toContain(1_000); timers.fire(1_000);
    // Then: SIGKILL escalation reaches final close and public close settles exactly once.
    await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined]);
    expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(transport.diagnostics().filter(item => item.code === "SECOND_BRAIN_SIGKILL")).toHaveLength(1);
    expect(transport.diagnostics().filter(item => item.code === "SECOND_BRAIN_CLOSED")).toHaveLength(1);
  });

  it.each(["\n", "\r\n"])("counts the %j delimiter inside the inbound frame cap", async delimiter => {
    const child = new SignalProcess(true, true, true); let dispatched: ((id: string) => void) | undefined; const transport = createSecondBrainTransport({ launcherPath: "/fake", configPath: "/config", realpath: path => path, execFile: () => child as unknown as ChildProcess, onDiagnostic: item => { if (item.code === "SECOND_BRAIN_REQUESTED" && item.request_id) dispatched?.(item.request_id); } }); transports.push(transport); const id = new Promise<string>(resolve => { dispatched = resolve; }); const call = transport.call("sb_search", { query: "cap" }); const requestId = await id;
    const response = (bodyBytes: number): Buffer => { const message = { jsonrpc: "2.0", id: requestId, result: { content: [{ type: "text", text: JSON.stringify({ results: [], padding: "" }) }], isError: false } }; const empty = Buffer.byteLength(JSON.stringify(message)); const padding = "x".repeat(bodyBytes - empty); const entry = message.result.content[0]; if (entry) entry.text = JSON.stringify({ results: [], padding }); return Buffer.from(`${JSON.stringify(message)}${delimiter}`); };
    child.stdout.write(response(1_048_576 - Buffer.byteLength(delimiter))); await expect(call).resolves.toMatchObject({ kind: "no_data" });
    const nextId = new Promise<string>(resolve => { dispatched = resolve; }); const oversized = transport.call("sb_search", { query: "plus-one" }); await nextId; child.stdout.write(response(1_048_577 - Buffer.byteLength(delimiter))); await expect(oversized).rejects.toMatchObject({ code: "SECOND_BRAIN_OVERSIZE_FRAME" });
  });

  it.each([false, true])("bounds shutdown when SIGKILL result is %s but close is never observed", async killResult => {
    const timers = new ManualTimers(); const child = new SignalProcess(killResult); let launches = 0; const transport = createSecondBrainTransport({ launcherPath: "/fake", configPath: "/config", realpath: path => path, execFile: () => { launches += 1; return child as unknown as ChildProcess; }, timers, shutdownGraceMs: 10 }); transports.push(transport);
    await expect(transport.call("sb_search", { query: "ready" })).resolves.toMatchObject({ kind: "no_data" }); const first = transport.close(); const second = transport.close(); timers.fire(10); timers.fire(10);
    await expect(first).rejects.toMatchObject({ code: "SECOND_BRAIN_SHUTDOWN_FAILED", disposition: "fatal" }); await expect(second).rejects.toMatchObject({ code: "SECOND_BRAIN_SHUTDOWN_FAILED" }); expect(child.signals).toEqual(["SIGTERM", "SIGKILL"]); expect(launches).toBe(1); expect(timers.count).toBe(0);
  });

  it("shutdown cancels queued and in-flight work and leaves no owned timers", async () => {
    const value = fixture(); const transport = createSecondBrainTransport(options(value)); transports.push(transport);
    const active = transport.call("sb_search", { query: "active", hold: true }); const queued = Array.from({ length: 5 }, (_, index) => transport.call("sb_search", { query: String(index), hold: true })); const settled = Promise.allSettled([active, ...queued]);
    await receiptSignal(value.receipt, 4); await transport.close();
    const results = await settled; expect(results.every(item => item.status === "rejected")).toBe(true);
    expect(transport.diagnostics().at(-1)).toMatchObject({ code: "SECOND_BRAIN_CLOSED", pending_count: 0, queued_count: 0 });
    expect(transport.diagnostics().filter(item => item.code === "SECOND_BRAIN_CLOSED")).toHaveLength(1);
  });
});
