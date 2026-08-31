import { describe, expect, it } from "vitest";
import { MEMORY_OUTBOX_RUNTIME_DEADLINE_MS, MemoryOutboxService } from "../../src/index.js";
import { memoryOutboxHash } from "../../src/memory-outbox-values.js";
describe("memory outbox V2 values", () => {
  it("freezes domain-separated identities and the ten-minute runtime deadline", () => {
    expect(memoryOutboxHash("memory-outbox", { a: 1 })).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(memoryOutboxHash("memory-outbox", { a: 1 })).not.toBe(memoryOutboxHash("memory-outbox-audit", { a: 1 }));
    expect(MEMORY_OUTBOX_RUNTIME_DEADLINE_MS).toBe(600_000);
  });
  it("rejects unbounded constructor durations", () => {
    const stub = {} as ConstructorParameters<typeof MemoryOutboxService>[0];
    expect(() => new MemoryOutboxService({ ...stub, leaseMs: 0 })).toThrow("MEMORY_OUTBOX_CONFIG_INVALID");
    expect(() => new MemoryOutboxService({ ...stub, artifactDeadlineMs: 600_001 })).toThrow("MEMORY_OUTBOX_CONFIG_INVALID");
  });
});
