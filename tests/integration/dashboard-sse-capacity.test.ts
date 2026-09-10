import { once } from "node:events";
import { createServer, get, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, it, vi } from "vitest";
import { ReconcileHub, SSE_MAX_CLIENTS } from "../../src/dashboard/events.js";
import { tryHandleDashboardSse } from "../../src/dashboard/sse-route.js";

it("rejects excess real HTTP streams and admits a replacement without evicting existing clients", async () => {
  const hub = new ReconcileHub();
  const streams: IncomingMessage[] = [];
  const server = createServer((request, response) => {
    tryHandleDashboardSse({ path: "/api/v1/events", request, response, hub, requestId: "capacity-test" });
  });
  try {
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/events`;
    const open = () => new Promise<IncomingMessage>((resolve, reject) => {
      const request = get(url, { agent: false }, response => {
        // Destroying a test stream is intentional; consume errors during teardown.
        response.on("error", () => {});
        streams.push(response); resolve(response);
      });
      request.on("error", reject);
    });
    for (let index = 0; index < SSE_MAX_CLIENTS; index++) {
      const response = await open();
      expect(response.statusCode).toBe(200); response.resume();
    }
    expect(hub.hasCapacity).toBe(false);
    const excess = await open();
    expect(excess.statusCode).toBe(503);
    expect(excess.headers["retry-after"]).toBe("5");
    expect(excess.headers["content-type"]).toContain("application/json");
    let body = "";
    for await (const chunk of excess) body += String(chunk);
    expect(JSON.parse(body).error.code).toBe("SSE_CAPACITY_EXCEEDED");
    const remaining = streams[1]!;
    let delivered = "";
    remaining.on("data", chunk => { delivered += String(chunk); });
    hub.publish(["task:capacity-survivor"]);
    await vi.waitFor(() => expect(delivered).toContain("task:capacity-survivor"));
    streams[0]!.destroy();
    await vi.waitFor(() => expect(hub.hasCapacity).toBe(true));
    const replacement = await open();
    expect(replacement.statusCode).toBe(200); replacement.resume();
    expect(hub.hasCapacity).toBe(false);
  } finally {
    for (const stream of streams) stream.destroy();
    hub.close();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}, 15_000);

it("enforces direct hub admission and releases all capacity on close", () => {
  const hub = new ReconcileHub();
  try {
    for (let index = 0; index < SSE_MAX_CLIENTS; index++) hub.connect({ write() {}, close() {} });
    const rejected = { write: vi.fn(), close: vi.fn() };
    expect(() => hub.connect(rejected)).toThrow("SSE_CAPACITY_EXCEEDED");
    expect(rejected.write).not.toHaveBeenCalled();
    hub.close(); expect(hub.hasCapacity).toBe(true);
    hub.connect(rejected); expect(rejected.write).toHaveBeenCalledTimes(1);
  } finally { hub.close(); }
});
