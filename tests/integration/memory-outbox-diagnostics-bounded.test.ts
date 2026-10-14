import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryOutboxStore } from "../../src/memory-outbox-store.js";
import { closeMemoryDatabase } from "../fixtures/memory-candidate-store.js";
import { claimAction, outboxFixture, type OutboxFixture } from "../fixtures/memory-outbox-fixture.js";

const fixtures: OutboxFixture[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const f of fixtures.splice(0)) closeMemoryDatabase(f.database); });

describe("limit-bounded diagnostic database work", () => {
  it.each([4, 12])("does not rescan all %i unresolved writer failures during a limit-one cycle", async backlog => {
    const owner = await outboxFixture({ deadline: 60_000 });
    fixtures.push(owner);
    vi.spyOn(owner.writer, "write").mockRejectedValue(new Error("PRIVATE_SENTINEL"));
    for (let index = 0; index < backlog; index += 1) {
      const item = index === 0 ? owner : await outboxFixture({
        database: owner.database, suffix: `-backlog-${index}`, deadline: 60_000,
      });
      owner.service.enqueue(claimAction(item));
      expect((await owner.service.runOnce("backlog-seed", 1)).failure?.phase).toBe("provider_write");
    }
    expect(owner.service.list({ state: "reconciling", limit: backlog })).toHaveLength(backlog);
    const reads = vi.spyOn(MemoryOutboxStore.prototype, "get");

    const cycle = await owner.service.runOnce("bounded-idle", 1);

    expect(cycle.dispatched).toBe(0);
    expect(cycle.failure?.phase).toBe("provider_write");
    expect(reads.mock.calls.length).toBeLessThanOrEqual(6);
    expect(owner.writer.write).toHaveBeenCalledTimes(backlog);
  });
});
