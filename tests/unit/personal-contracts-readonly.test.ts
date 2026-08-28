import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const FIXTURE = "test/fixtures/personal-contracts-readonly-negative.ts.txt";

describe("personal contract compile-time readonly surface", () => {
  it("rejects mutation of every embedded approval signature", () => {
    // Given a strict compiler input that mutates all five public receipt positions
    const root = mkdtempSync(join(process.cwd(), ".task9-readonly-"));
    const input = join(root, "readonly-negative.ts");
    writeFileSync(input, readFileSync(FIXTURE, "utf8"));
    try {
      // When TypeScript checks the public contract without emitting
      const result = spawnSync(join(process.cwd(), "node_modules/.bin/tsc"), ["--strict", "--noEmit", "--target", "ES2024", "--module", "NodeNext", "--moduleResolution", "NodeNext", "--types", "node", "--skipLibCheck", input], { cwd: process.cwd(), encoding: "utf8" });
      // Then every nested signature assignment is rejected as readonly
      const diagnostics = `${result.stdout}${result.stderr}`;
      expect(result.status).not.toBe(0);
      expect(diagnostics.match(/TS2540/g)).toHaveLength(5);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
