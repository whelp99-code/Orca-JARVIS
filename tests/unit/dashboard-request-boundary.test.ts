import { describe, expect, it } from "vitest";
import { hasExactMutationOrigin } from "../../src/dashboard/request-boundary.js";

const EXPECTED = "http://127.0.0.1:43123";

describe("dashboard mutation Origin boundary", () => {
  it.each([
    ["missing", []],
    ["wrong scheme", ["Origin", "https://127.0.0.1:43123"]],
    ["wrong host", ["Origin", "http://localhost:43123"]],
    ["wrong port", ["Origin", "http://127.0.0.1:43124"]],
    ["null", ["Origin", "null"]],
    ["comma joined", ["Origin", `${EXPECTED}, ${EXPECTED}`]],
    ["whitespace ambiguous", ["Origin", `${EXPECTED} ${EXPECTED}`]],
    ["duplicate", ["Origin", EXPECTED, "Origin", EXPECTED]],
    ["mixed-case duplicate", ["origin", EXPECTED, "ORIGIN", EXPECTED]],
  ] as const)("rejects %s", (_name, rawHeaders) => {
    expect(hasExactMutationOrigin({ rawHeaders: [...rawHeaders] }, EXPECTED)).toBe(false);
  });

  it("accepts exactly one case-insensitive Origin header with the exact value", () => {
    expect(hasExactMutationOrigin({ rawHeaders: ["oRiGiN", EXPECTED] }, EXPECTED)).toBe(true);
  });
});
