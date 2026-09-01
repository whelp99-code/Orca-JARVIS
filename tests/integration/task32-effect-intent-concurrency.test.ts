import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("Task 32 effect intent concurrency", () => {
  it("publishes correction bytes before committing authority rows", () => {
    const source = readFileSync("src/dashboard/memory-mutation-service.ts", "utf8");
    const publication = source.indexOf("await this.publishCorrection");
    const transaction = source.indexOf("this.options.authority.db.transaction", publication);
    expect(publication).toBeGreaterThan(-1);
    expect(transaction).toBeGreaterThan(publication);
    expect(source).toContain("MEMORY_INTENT_EXPIRED");
  });
});
