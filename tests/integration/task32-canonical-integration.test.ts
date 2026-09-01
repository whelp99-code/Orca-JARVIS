import { describe, expect, it } from "vitest";
import { canonicalize } from "../../src/canonical.js";

describe("Task 32 canonical integration", () => {
  it("makes digest inputs independent of insertion order", () => {
    expect(canonicalize({ b: 2, a: 1, nested: { d: false, c: null } }))
      .toBe('{"a":1,"b":2,"nested":{"c":null,"d":false}}');
  });
});
