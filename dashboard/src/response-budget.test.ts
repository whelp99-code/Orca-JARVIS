import { afterEach, describe, expect, it, vi } from "vitest";
import { requestPersonalJson } from "./personal-http.js";
import { createMemoryClient } from "./memory-api.js";
import { readBoundedJson, ResponseBodyTooLargeError } from "./bounded-response.js";

afterEach(() => vi.unstubAllGlobals());

describe("personal and memory response byte budgets", () => {
  it.each([false, true])("accepts the exact UTF-8 payload limit with split chunks and BOM=%s", async bom => {
    const value = `${"가".repeat(21_844)}aa`;
    const raw = new TextEncoder().encode(JSON.stringify(value));
    expect(raw.byteLength).toBe(65_536);
    const stream = new ReadableStream<Uint8Array>({ start(controller) {
      if (bom) for (const byte of [0xef, 0xbb, 0xbf]) controller.enqueue(new Uint8Array([byte]));
      for (let offset = 0; offset < raw.byteLength; offset += 4095) controller.enqueue(raw.slice(offset, offset + 4095));
      controller.close();
    } });
    await expect(readBoundedJson(new Response(stream), 65_536)).resolves.toBe(value);
  });

  it("keeps replacement-character bytes inside the existing decoded UTF-8 budget", async () => {
    const malformed = new Uint8Array([34, 0xff, 34]);
    await expect(readBoundedJson(new Response(malformed), 5)).resolves.toBe("�");
    await expect(readBoundedJson(new Response(malformed), 4)).rejects.toBeInstanceOf(ResponseBodyTooLargeError);
  });

  it.each(["reject", "pending"])("rejects over-budget input even when stream cancellation is %s", async mode => {
    let canceled = 0;
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array(65_537)); },
      cancel() { canceled++; return mode === "reject" ? Promise.reject(new Error("cancel failed")) : new Promise(() => {}); },
    }));
    await expect(readBoundedJson(response, 65_536)).rejects.toBeInstanceOf(ResponseBodyTooLargeError);
    expect(canceled).toBe(1);
    expect(response.body?.locked).toBe(false);
  });

  it("releases readers after empty, malformed, and interrupted bodies", async () => {
    const empty = new Response(null);
    await expect(readBoundedJson(empty, 64)).rejects.toBeInstanceOf(SyntaxError);
    const invalid = new Response("{broken");
    await expect(readBoundedJson(invalid, 64)).rejects.toBeInstanceOf(SyntaxError);
    expect(invalid.body?.locked).toBe(false);
    const failure = new TypeError("transport interrupted");
    const broken = new Response(new ReadableStream({ start(controller) { controller.error(failure); } }));
    await expect(readBoundedJson(broken, 64)).rejects.toBe(failure);
    expect(broken.body?.locked).toBe(false);
  });

  it.each(["personal", "memory"] as const)("cancels an oversized %s stream before EOF", async kind => {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    let canceled = 0;
    const stream = new ReadableStream<Uint8Array>({
      start(value) { controller = value; },
      cancel() { canceled++; },
    });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(stream)));
    const reading = (kind === "personal" ? requestPersonalJson("/api/v1/today", {})
      : createMemoryClient(async () => ({ schema_version: 1, csrf_token: "test" })).status())
      .catch((error: unknown) => error);
    try {
      controller.enqueue(new Uint8Array(65_537).fill(97));
      // Allow fetch/session and the first read continuation; the stream deliberately has no EOF.
      for (let i = 0; i < 8; i++) await Promise.resolve();
      expect(canceled).toBe(1);
    } finally {
      if (!canceled) controller.close();
      const error = await reading;
      expect(error).toMatchObject(kind === "personal" ? { code: "VALIDATION_ERROR" } : { message: "MEMORY_RESPONSE_TOO_LARGE" });
    }
  });
});
