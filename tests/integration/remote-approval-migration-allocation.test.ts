import { readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

const GRAMMAR = /^(?<id>[0-9]{3})_(?<slug>[a-z0-9]+(?:_[a-z0-9]+)*)[.]sql$/;

describe("task 35 migration allocation grammar", () => {
  it("keeps contiguous grammar-matching migration files including 056", () => {
    const files = readdirSync("migrations").filter(name => name.endsWith(".sql")).sort();
    const ids = files.map(name => {
      const match = GRAMMAR.exec(name);
      expect(match, name).not.toBeNull();
      return Number(match?.groups?.id);
    });
    expect(ids[0]).toBe(1);
    for (let index = 1; index < ids.length; index += 1) {
      const previous = ids[index - 1] ?? 0;
      const current = ids[index] ?? 0;
      // a6afd5a restored historical 028_budgeted_evolution_memory.sql beside 028_negative_evidence.sql.
      if (current === 28 && previous === 28) continue;
      expect(current).toBe(previous + 1);
    }
    expect(files).toContain("056_remote_approval_v2.sql");
  });
});
