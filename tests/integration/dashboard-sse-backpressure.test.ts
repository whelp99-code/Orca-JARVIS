import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ReconcileHub } from "../../src/dashboard/events.js";
import { createBoundedSseSink, SSE_BUFFER_MAX_BYTES, SSE_DRAIN_TIMEOUT_MS } from "../../src/dashboard/sse-bounded-sink.js";
import { tryHandleDashboardSse } from "../../src/dashboard/sse-route.js";
import { MEMORY_TOPICS } from "../../src/dashboard/memory-contracts.js";

class Response extends EventEmitter {
  writableLength = 0;
  writableEnded = false;
  destroyed = false;
  accepts = true;
  throws = false;
  frames: string[] = [];
  setHeader(): void {}
  flushHeaders(): void {}
  write(frame: string): boolean {
    if (this.throws) throw new Error("closed socket");
    this.frames.push(frame);
    return this.accepts;
  }
  destroy(): void { this.destroyed = true; this.emit("close"); }
  native(): ServerResponse { return this as unknown as ServerResponse; }
}
function payload(frame: string) {
  return JSON.parse(frame.split("\n").find(line => line.startsWith("data: "))!.slice(6)) as
    { type: string; revision: string; topics: string[] };
}
function frameId(frame: string): string { return frame.split("\n")[0]!.slice(4); }
afterEach(() => vi.useRealTimers());

describe("bounded dashboard SSE delivery", () => {
  it("coalesces 20000 blocked invalidations into a fresh complete snapshot after drain", () => {
    const hub = new ReconcileHub(); const response = new Response(); response.accepts = false;
    let unsubscribe = () => {}; let snapshots = 0;
    const sink = createBoundedSseSink(response.native(), () => { snapshots++; hub.resync(sink); }, () => unsubscribe());
    unsubscribe = hub.connect(sink);
    for (let index = 0; index < 20000; index++) hub.publish(["tasks", `task:${index}`, "memory.privacy.v1"]);
    expect(response.frames).toHaveLength(1);
    response.accepts = true; response.emit("drain");
    expect(response.frames).toHaveLength(2); expect(snapshots).toBe(1);
    const recovered = payload(response.frames[1]!);
    expect(recovered.type).toBe("snapshot");
    expect(recovered.topics).toEqual(expect.arrayContaining(["tasks", "approvals", ...MEMORY_TOPICS]));
    expect(Number(recovered.revision.split(":")[1])).toBeGreaterThan(20000);
    response.emit("drain"); expect(response.frames).toHaveLength(2);
    hub.publish(["agents"]); expect(payload(response.frames[2]!).topics).toEqual(["agents"]);
    sink.close(); hub.close();
  });

  it("times out a blocked socket without extending its deadline for heartbeats or updates", () => {
    vi.useFakeTimers(); const response = new Response(); response.accepts = false;
    const closed = vi.fn(); const snapshot = vi.fn();
    const sink = createBoundedSseSink(response.native(), snapshot, closed);
    sink.write("data: first\n\n");
    vi.advanceTimersByTime(SSE_DRAIN_TIMEOUT_MS - 1);
    sink.write(":\n\n"); sink.write("data: later\n\n");
    expect(response.destroyed).toBe(false);
    vi.advanceTimersByTime(1);
    expect(response.destroyed).toBe(true); expect(closed).toHaveBeenCalledTimes(1);
    response.emit("drain"); sink.write("data: late\n\n"); sink.close();
    expect(response.frames).toHaveLength(1); expect(snapshot).not.toHaveBeenCalled();
    expect(response.listenerCount("drain")).toBe(0); expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels a recovered deadline and does not turn skipped heartbeats into invalidations", () => {
    vi.useFakeTimers(); const response = new Response(); response.accepts = false;
    const snapshot = vi.fn(); const sink = createBoundedSseSink(response.native(), snapshot, () => {});
    sink.write("data: first\n\n"); sink.write(":\n\n");
    response.accepts = true; response.emit("drain"); vi.advanceTimersByTime(SSE_DRAIN_TIMEOUT_MS);
    expect(snapshot).not.toHaveBeenCalled(); expect(response.destroyed).toBe(false);
    sink.write("data: later\n\n"); expect(response.frames).toHaveLength(2); sink.close();
  });

  it("refuses oversized UTF-8 frames and prefilled writable buffers before writing", () => {
    for (const mode of ["frame", "buffer"]) {
      const response = new Response(); const closed = vi.fn();
      if (mode === "buffer") response.writableLength = SSE_BUFFER_MAX_BYTES - 16;
      const sink = createBoundedSseSink(response.native(), () => {}, closed);
      sink.write(mode === "frame" ? "한".repeat(6000) : "data: first\n\n");
      expect(response.destroyed).toBe(true); expect(response.frames).toHaveLength(0);
      expect(closed).toHaveBeenCalledTimes(1); expect(response.listenerCount("drain")).toBe(0);
    }
  });

  it("cleans up a route that closes during its initial snapshot and one that fails on heartbeat", () => {
    vi.useFakeTimers();
    for (const failure of ["initial", "heartbeat"]) {
      const hub = new ReconcileHub(); const response = new Response(); response.throws = failure === "initial";
      const request = Object.assign(new EventEmitter(), { headers: {} });
      const stop = vi.fn(); const connect = hub.connect.bind(hub);
      vi.spyOn(hub, "connect").mockImplementation((sink, id) => { const unsubscribe = connect(sink, id);
        return () => { stop(); unsubscribe(); }; });
      expect(tryHandleDashboardSse({ path: "/api/v1/events", request: request as IncomingMessage,
        response: response.native(), requestId: "sse:test", hub })).toBe(true);
      if (failure === "heartbeat") { response.throws = true; vi.advanceTimersByTime(15000); }
      expect(response.destroyed).toBe(true); expect(stop).toHaveBeenCalledTimes(1);
      expect(request.listenerCount("close")).toBe(0); expect(vi.getTimerCount()).toBe(0);
      hub.close();
    }
  });

  it("reconciles a backpressured replay and preserves a working subscriber when another throws", () => {
    const hub = new ReconcileHub(); const history: string[] = [];
    const stop = hub.connect({ write: frame => { history.push(frame); }, close() {} });
    hub.publish(["tasks"]); const checkpoint = frameId(history[1]!);
    for (let i = 0; i < 20; i++) hub.publish(["agents"]);
    stop(); const response = new Response(); response.accepts = false;
    let unsubscribe = () => {};
    const sink = createBoundedSseSink(response.native(), () => hub.resync(sink), () => unsubscribe());
    unsubscribe = hub.connect(sink, checkpoint); expect(response.frames).toHaveLength(1);
    response.accepts = true; response.emit("drain");
    expect(payload(response.frames[1]!).type).toBe("snapshot");
    let fail = false; const deadClose = vi.fn();
    hub.connect({ write() { if (fail) throw new Error("broken subscriber"); }, close: deadClose });
    const good: string[] = []; hub.connect({ write: frame => { good.push(frame); }, close() {} });
    fail = true; hub.publish(["tasks"]); hub.publish(["agents"]);
    expect(deadClose).toHaveBeenCalledTimes(1); expect(good).toHaveLength(3);
    expect(payload(good[2]!).topics).toEqual(["agents"]); hub.close();
  });

  it("keeps topic-count, UTF-8 and JSON-escaped overflow within the clients' snapshot contract", () => {
    const hub = new ReconcileHub(); const frames: string[] = [];
    hub.connect({ write: frame => { frames.push(frame); }, close() {} });
    for (const topics of [Array.from({ length: 33 }, (_, i) => `task:${i}`), ["한".repeat(86)],
      Array.from({ length: 32 }, (_, i) => "\u0000".repeat(250) + i)]) {
      hub.publish(topics); const frame = frames.at(-1)!; const decoded = payload(frame);
      expect(Buffer.byteLength(frame, "utf8")).toBeLessThanOrEqual(16384);
      expect(decoded.type).toBe("snapshot"); expect(decoded.topics.length).toBeLessThanOrEqual(32);
      expect(decoded.topics).toEqual(payload(frames[0]!).topics);
    }
    const replay: string[] = [];
    hub.connect({ write: frame => { replay.push(frame); }, close() {} }, frameId(frames[1]!));
    expect(replay).toHaveLength(2);
    expect(replay.every(frame => Buffer.byteLength(frame, "utf8") <= 16384)).toBe(true); hub.close();
  });
});
