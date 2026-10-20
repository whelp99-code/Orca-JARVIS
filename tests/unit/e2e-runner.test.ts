import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

it("includes phone hub acceptance in the canonical e2e spec list", () => {
  const runner = readFileSync("scripts/run-tests.mjs", "utf8");
  const e2eList = runner.match(/if \(profile === "e2e"\) argv = \[([\s\S]*?)\];/)?.[1];
  expect(e2eList).toContain('"e2e/phone-gateway-spa.spec.ts"');
});
