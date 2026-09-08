import { describe, expect, it } from "vitest";
import { withMemoryContentRepresentations } from "../../src/memory-content-representations.js";

describe("temporary memory representation ownership", () => {
  it("rejects asynchronous consumers and wipes their temporary buffers", () => {
    const raw = Buffer.from('기억\n"A"');
    let retained: readonly Buffer[] = [];
    expect(() => withMemoryContentRepresentations([raw], values => {
      retained = values.slice(1);
      return Promise.resolve(1);
    })).toThrowError(expect.objectContaining({ code: "MEMORY_CONTENT_REPRESENTATION_ASYNC" }));
    expect(retained).toHaveLength(2);
    expect(retained.every(value => value.every(byte => byte === 0))).toBe(true);
    expect(raw.toString()).toBe('기억\n"A"');
  });

  it("matches JSON.stringify for all control bytes and UTF-8 without changing caller buffers", () => {
    const text = String.fromCharCode(...Array.from({ length: 32 }, (_, i) => i)) + '"\\/기억🚢\u2028';
    const raw = Buffer.from(text);
    const once = JSON.stringify(text).slice(1, -1);
    const twice = JSON.stringify(once).slice(1, -1);
    let retained: readonly Buffer[] = [];
    withMemoryContentRepresentations([raw], values => {
      expect(values.map(value => value.toString("utf8"))).toEqual([text, once, twice]);
      retained = values.slice(1);
    });
    expect(retained.every(value => value.every(byte => byte === 0))).toBe(true);
    expect(raw.toString("utf8")).toBe(text);
  });

  it("wipes generated buffers when the consumer fails and preserves raw ownership", () => {
    const raw = Buffer.from('기억\n"A"');
    let retained: readonly Buffer[] = [];
    expect(() => withMemoryContentRepresentations([raw], values => {
      retained = values.slice(1);
      throw new Error("consumer-failed");
    })).toThrow("consumer-failed");
    expect(retained).toHaveLength(2);
    expect(retained.every(value => value.every(byte => byte === 0))).toBe(true);
    expect(raw.toString()).toBe('기억\n"A"');
  });

  it("deduplicates plain text, empty inputs and raw/escaped overlaps", () => {
    const plain = Buffer.from("plain 기억");
    withMemoryContentRepresentations([plain, plain, Buffer.alloc(0)], values => {
      expect(values).toEqual([plain]);
    });
    const raw = Buffer.from('A\nB');
    const alreadyEscaped = Buffer.from('A\\nB');
    withMemoryContentRepresentations([raw, alreadyEscaped], values => {
      expect(new Set(values.map(value => value.toString("hex"))).size).toBe(values.length);
    });
    expect(alreadyEscaped.toString()).toBe('A\\nB');
  });

  it("rejects excessive item counts, input bytes and expansion before consuming", () => {
    let consumed = 0;
    const consume = () => { consumed += 1; };
    for (const material of [
      Array<Buffer>(100_001).fill(Buffer.alloc(0)),
      [Buffer.alloc(64 * 1024 * 1024 + 1)],
      [Buffer.alloc(6 * 1024 * 1024)],
    ]) {
      expect(() => withMemoryContentRepresentations(material, consume))
        .toThrowError(expect.objectContaining({ code: "MEMORY_CONTENT_REPRESENTATION_LIMIT" }));
    }
    expect(consumed).toBe(0);
  });
});
