import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("Task 32 review spool concurrency", () => {
  it("makes concurrent same-path publication create-or-verify only", () => {
    const source = readFileSync("src/memory-private-spool-files.ts", "utf8");
    expect(source).toContain("O_CREAT");
    expect(source).toContain("O_EXCL");
    expect(source).toContain("readPrivateSpoolFile");
    expect(source).toContain("linkSync(temporary, path)");
  });
});
