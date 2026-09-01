import { describe, expect, it } from "vitest";
import { parseSecondBrainStrictJsonBytes } from "../../src/second-brain-strict-json.js";

const bytes = (value: string): Buffer => Buffer.from(value, "utf8");

describe("Task 32 strict byte boundary", () => {
  it("accepts a well-formed unique-key object", () => {
    // Given a single-key object encoded as valid UTF-8
    const input = bytes('{"query":"principle","limit":5}');
    // When the shared boundary decoder parses it
    const parsed = parseSecondBrainStrictJsonBytes(input);
    // Then the typed value is returned
    expect(parsed).toEqual({ query: "principle", limit: 5 });
  });

  it("rejects duplicate top-level keys rather than keeping the last value", () => {
    // Given a body whose top-level authority is ambiguous
    const input = bytes('{"query":"a","query":"b"}');
    // When the shared boundary decoder parses it
    const parsed = parseSecondBrainStrictJsonBytes(input);
    // Then the decode is fatal instead of silently resolving to one side
    expect(parsed).toBeUndefined();
  });

  it("rejects duplicate nested keys at any depth", () => {
    // Given a nested duplicate that ordinary JSON.parse would collapse
    const input = bytes('{"payload":{"replacement":"a","replacement":"b"}}');
    // When the shared boundary decoder parses it
    const parsed = parseSecondBrainStrictJsonBytes(input);
    // Then the decode is fatal
    expect(parsed).toBeUndefined();
  });

  it("rejects malformed UTF-8 instead of replacement-decoding it", () => {
    // Given a body carrying an invalid continuation byte
    const input = Buffer.concat([bytes('{"query":"'), Buffer.from([0xff, 0xfe]), bytes('"}')]);
    // When the shared boundary decoder parses it
    const parsed = parseSecondBrainStrictJsonBytes(input);
    // Then no U+FFFD substitution reaches the interior
    expect(parsed).toBeUndefined();
  });

  it("keeps ordinary JSON.parse permissive, proving the decoder is the barrier", () => {
    // Given the same duplicate-key body
    const duplicate = '{"query":"a","query":"b"}';
    // When the platform parser reads it
    const permissive: unknown = JSON.parse(duplicate);
    // Then it silently accepts, which is exactly what the boundary must not do
    expect(permissive).toEqual({ query: "b" });
    expect(parseSecondBrainStrictJsonBytes(bytes(duplicate))).toBeUndefined();
  });
});
