import { afterEach, describe, expect, it } from "vitest";
import { closeMemoryDatabase } from "../fixtures/memory-candidate-store.js";
import { claimAction, outboxFixture, type OutboxFixture } from "../fixtures/memory-outbox-fixture.js";
const fixtures: OutboxFixture[] = [];
afterEach(() => { for (const fixture of fixtures.splice(0)) closeMemoryDatabase(fixture.database); });
describe("memory outbox concurrency and crash fencing", () => {
  it("allows thirty-two workers only one dispatch attempt", async () => {
    const fixture = await outboxFixture(); fixtures.push(fixture); fixture.service.enqueue(claimAction(fixture));
    await Promise.all(Array.from({ length: 32 }, (_, index) => fixture.service.runOnce(`worker-${index}`, 1)));
    expect(fixture.writer.calls).toHaveLength(1);
    expect((fixture.database.authority.db.prepare("SELECT COUNT(*) AS n FROM memory_outbox_attempts WHERE attempt_id LIKE 'memattempt:pos:v2:%'").get() as { n: number }).n).toBe(1);
  });

  it("recovers a dispatch marker conservatively without replay", async () => {
    const fixture = await outboxFixture(); fixtures.push(fixture); const queued = fixture.service.enqueue(claimAction(fixture));
    const store = Object.getOwnPropertyDescriptor(fixture.service, "store")?.value as {
      claimDispatch(worker: string, now: Date, lease: number): { outbox_id: string; lease_fence: number };
      markDispatch(id: string, worker: string, fence: number, now: Date): object;
    };
    const claimed = store.claimDispatch("crashed-worker", fixture.clock.now, 10_000);
    store.markDispatch(claimed.outbox_id, "crashed-worker", claimed.lease_fence, fixture.clock.now);
    fixture.clock.now = new Date(fixture.clock.now.getTime() + 10_000);
    await fixture.service.runOnce("restart-worker", 1);
    expect(fixture.writer.calls).toHaveLength(0);
    expect(fixture.service.get(queued.outbox_id)?.state).toBe("reconciling");
  });
});
