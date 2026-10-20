import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { resolveE2ePort } from "../../scripts/lib/e2e-port.mjs";

it.each([
  [undefined, undefined, 4174],
  [undefined, "54174", 54174],
  ["54175", undefined, 54175],
  ["54175", "54174", 54175],
  ["54175", "invalid", 54175],
  ["1", undefined, 1],
  [undefined, "65535", 65535],
])("uses primary port %s then seeded port %s to select %s", (port, seededPort, expected) => {
  expect(resolveE2ePort({ JARVIS_E2E_PORT: port, JARVIS_E2E_SEEDED_PORT_1440: seededPort }, 4174)).toBe(expected);
});

it.each(["", "0", "65536", "-1", "1.5", "1e3", "4174junk", " 4174", "4174 ", "4174\n", "NaN"])(
  "rejects invalid port %j through either environment variable",
  value => {
    expect(() => resolveE2ePort({ JARVIS_E2E_PORT: value, JARVIS_E2E_SEEDED_PORT_1440: "54174" }, 4174))
      .toThrow("JARVIS_E2E_PORT_INVALID");
    expect(() => resolveE2ePort({ JARVIS_E2E_SEEDED_PORT_1440: value }, 4174)).toThrow("JARVIS_E2E_PORT_INVALID");
  },
);

it("includes phone hub acceptance in the canonical e2e spec list", () => {
  const runner = readFileSync("scripts/run-tests.mjs", "utf8");
  const e2eList = runner.match(/if \(profile === "e2e"\) argv = \[([\s\S]*?)\];/)?.[1];
  expect(e2eList).toContain('"e2e/phone-gateway-spa.spec.ts"');
});
