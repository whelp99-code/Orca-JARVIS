import * as fs from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { bindDashboardMemoryDependencies } from "../../src/dashboard/memory-production.js";
import { memoryDatabase, closeMemoryDatabase } from "../fixtures/memory-candidate-store.js";
import { missingReader } from "../fixtures/memory-outbox-fixture.js";

vi.mock("node:fs", async importOriginal => ({ ...await importOriginal<typeof import("node:fs")>() }));

afterEach(() => vi.restoreAllMocks());

it("creates one private key and preserves it across subsequent startup", async () => {
  const database = await memoryDatabase();
  try {
    const first = bindDashboardMemoryDependencies(database.authority, { memoryAdapter: missingReader() });
    const second = bindDashboardMemoryDependencies(database.authority, { memoryAdapter: missingReader() });
    const path = join(database.root, "memory-projection.key");
    expect(first.memoryProjectionKey).toHaveLength(32);
    expect(second.memoryProjectionKey).toEqual(first.memoryProjectionKey);
    expect(fs.readFileSync(path)).toEqual(first.memoryProjectionKey);
    expect(fs.statSync(path).mode & 0o077).toBe(0);
  } finally { closeMemoryDatabase(database); }
});

it.each([32, 0])("preserves a competing startup's key without overwriting it (bytes=%s)", async size => {
  const database = await memoryDatabase();
  const path = join(database.root, "memory-projection.key");
  const winner = Buffer.alloc(size, 0x42);
  const write = fs.writeFileSync;
  let raced = false;
  vi.spyOn(fs, "writeFileSync").mockImplementation((target, data, options) => {
    if (target === path && !raced) {
      raced = true;
      // Publish a real competing file after the first missing-key read, before creation.
      write(path, winner, { flag: "wx", mode: 0o600 });
    }
    return write(target, data, options);
  });
  try {
    const start = () => bindDashboardMemoryDependencies(database.authority, { memoryAdapter: missingReader() });
    if (size === 32) expect(start().memoryProjectionKey).toEqual(winner);
    else expect(start).toThrow("VALIDATION_ERROR");
    expect(raced).toBe(true);
    expect(fs.readFileSync(path)).toEqual(winner);
  } finally { closeMemoryDatabase(database); }
});
