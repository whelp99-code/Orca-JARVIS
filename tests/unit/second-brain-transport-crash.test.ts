import { execFile, type ChildProcess } from "node:child_process";
import { writeFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { createSecondBrainTransport, type SecondBrainExecFile } from "../../src/second-brain-transport.js";
import { ManualTimers, cleanupFixtures, fixture, forceKill, options, receiptSignal } from "../fixtures/second-brain-transport-harness.js";

const transports: Array<{ close(): Promise<void> }> = [];
afterEach(async () => { await Promise.all(transports.splice(0).map(item => item.close())); cleanupFixtures(); });

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

  it("shutdown cancels queued and in-flight work and leaves no owned timers", async () => {
    const value = fixture(); const transport = createSecondBrainTransport(options(value)); transports.push(transport);
    const active = transport.call("sb_search", { query: "active", hold: true }); const queued = Array.from({ length: 5 }, (_, index) => transport.call("sb_search", { query: String(index), hold: true })); const settled = Promise.allSettled([active, ...queued]);
    await receiptSignal(value.receipt, 4); await transport.close();
    const results = await settled; expect(results.every(item => item.status === "rejected")).toBe(true);
    expect(transport.diagnostics().at(-1)).toMatchObject({ code: "SECOND_BRAIN_CLOSED", pending_count: 0, queued_count: 0 });
    expect(transport.diagnostics().filter(item => item.code === "SECOND_BRAIN_CLOSED")).toHaveLength(1);
  });
});
