import { deepStrictEqual } from "node:assert";
import { describe, expect, it } from "vitest";
import { parseSecondBrainStrictJsonBytes } from "../../src/second-brain-strict-json.js";

function expectFrozenJson(value: unknown): void {
  if (value === null || typeof value !== "object") return;
  expect(Object.isFrozen(value)).toBe(true);
  expect(Object.getPrototypeOf(value)).toBe(Array.isArray(value) ? Array.prototype : Object.prototype);
  for (const child of Object.values(value)) expectFrozenJson(child);
}

describe("strict JSON property preservation", () => {
  it.each([
    '{"ok":false,"__proto__":{"error":{"code":"runtime_unavailable","message":"x"}}}',
    '{"__proto__":null,"safe":1}',
    '{"nested":[{"__proto__":{"admin":true},"constructor":{"prototype":{"admin":true}},"toString":"plain"}]}',
  ])("preserves every own key and ordinary prototype: %s", input => {
    const parsed = parseSecondBrainStrictJsonBytes(Buffer.from(input));
    expect(JSON.stringify(parsed)).toBe(input);
    deepStrictEqual(parsed, JSON.parse(input));
    expectFrozenJson(parsed);
    expect(Object.hasOwn(Object.prototype, "admin")).toBe(false);
    expect(Object.hasOwn(Object.prototype, "error")).toBe(false);
  });

  it("preserves escaped property names as data and rejects equivalent duplicates", () => {
    const input = '{"\\u005f_proto__":{"nested":1}}';
    const parsed = parseSecondBrainStrictJsonBytes(Buffer.from(input));
    deepStrictEqual(parsed, JSON.parse(input));
    expectFrozenJson(parsed);
    expect(parseSecondBrainStrictJsonBytes(Buffer.from('{"__proto__":{},"\\u005f_proto__":null}')))
      .toBeUndefined();
  });
});
