import { once } from "node:events";
import { createServer } from "node:http";
import { connect, type AddressInfo, type Socket } from "node:net";
import { expect, it } from "vitest";
import {
  createBoundedSseSink, SSE_BUFFER_MAX_BYTES, SSE_DRAIN_TIMEOUT_MS,
} from "../../src/dashboard/sse-bounded-sink.js";

it("bounds a real HTTP writable and disconnects a TCP client that stops reading", async () => {
  let client: Socket | undefined;
  let sink: ReturnType<typeof createBoundedSseSink> | undefined;
  let pump: ReturnType<typeof setInterval> | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let attempts = 0;
  let writes = 0;
  let peakBytes = 0;
  let lastBlockedAt: number | undefined;
  let closedAt = 0;
  let signalClosed = (): void => {};
  const closed = new Promise<void>(resolve => { signalClosed = resolve; });
  const server = createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    const write = response.write.bind(response);
    // Observe the actual writable, without faking its return value or buffer size.
    response.write = ((...args: Parameters<typeof response.write>) => {
      writes += 1;
      const accepts = write(...args);
      peakBytes = Math.max(peakBytes, response.writableLength);
      if (!accepts) lastBlockedAt = performance.now();
      return accepts;
    }) as typeof response.write;
    sink = createBoundedSseSink(response, () => {}, () => {
      closedAt = performance.now();
      clearInterval(pump);
      signalClosed();
    });
    const frame = `data: ${"x".repeat(16_000)}\n\n`;
    pump = setInterval(() => {
      for (let index = 0; index < 1_000; index += 1) {
        attempts += 1;
        sink!.write(frame);
      }
    }, 10);
  });
  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    client = connect((server.address() as AddressInfo).port, "127.0.0.1");
    await once(client, "connect");
    client.write("GET /events HTTP/1.1\r\nHost: localhost\r\n\r\n");
    client.pause();
    await Promise.race([closed, new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => reject(new Error("Slow SSE client did not close")), 20_000);
    })]);
    expect(lastBlockedAt).toBeDefined();
    expect(peakBytes).toBeGreaterThan(0);
    expect(peakBytes).toBeLessThanOrEqual(SSE_BUFFER_MAX_BYTES);
    expect(attempts).toBeGreaterThan(writes * 100);
    expect(closedAt - lastBlockedAt!).toBeGreaterThanOrEqual(SSE_DRAIN_TIMEOUT_MS - 100);
    // Allow scheduling delay on shared CI hosts while detecting a repeatedly extended deadline.
    expect(closedAt - lastBlockedAt!).toBeLessThan(SSE_DRAIN_TIMEOUT_MS + 5_000);
  } finally {
    clearInterval(pump);
    clearTimeout(timeout);
    sink?.close();
    client?.destroy();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}, 25_000);
