import { afterEach, describe, expect, it } from "vitest";
import { closeMemoryDatabase } from "../fixtures/memory-candidate-store.js";
import { claimAction, FixtureWriter, outboxFixture, type OutboxFixture } from "../fixtures/memory-outbox-fixture.js";
const fixtures: OutboxFixture[] = [];
afterEach(() => { for (const fixture of fixtures.splice(0)) closeMemoryDatabase(fixture.database); });
function internalStore(fixture: OutboxFixture): {
  claimDispatch(worker: string, now: Date, lease: number): { outbox_id: string; lease_fence: number };
  markDispatch(id: string, worker: string, fence: number, now: Date): object;
} {
  return Object.getOwnPropertyDescriptor(fixture.service, "store")?.value as ReturnType<typeof internalStore>;
}
describe("memory outbox concurrency and crash fencing", () => {
  it("allows thirty-two workers only one dispatch attempt", async () => {
    const fixture = await outboxFixture(); fixtures.push(fixture); fixture.service.enqueue(claimAction(fixture));
    await Promise.all(Array.from({ length: 32 }, (_, index) => fixture.service.runOnce(`worker-${index}`, 1)));
    expect(fixture.writer.calls).toHaveLength(1);
    expect((fixture.database.authority.db.prepare("SELECT COUNT(*) AS n FROM memory_outbox_attempts WHERE attempt_id LIKE 'memattempt:pos:v2:%'").get() as { n: number }).n).toBe(1);
  });

  it("recovers a dispatch marker conservatively without replay", async () => {
    const fixture = await outboxFixture(); fixtures.push(fixture); const queued = fixture.service.enqueue(claimAction(fixture));
    const store = internalStore(fixture);
    const claimed = store.claimDispatch("crashed-worker", fixture.clock.now, 10_000);
    store.markDispatch(claimed.outbox_id, "crashed-worker", claimed.lease_fence, fixture.clock.now);
    expect(fixture.database.authority.db.prepare("SELECT state FROM memory_candidates WHERE candidate_id=?")
      .get(queued.candidate_id)).toEqual({ state: "accepted_unsettled" });
    fixture.clock.now = new Date(fixture.clock.now.getTime() + 10_000);
    await fixture.service.runOnce("restart-worker", 1);
    expect(fixture.writer.calls).toHaveLength(0);
    expect(fixture.service.get(queued.outbox_id)?.state).toBe("reconciling");
  });

  it("records an uncertain frame write and never replays it", async () => {
    const writer = new FixtureWriter("uncertain"); const fixture = await outboxFixture({ writer }); fixtures.push(fixture);
    fixture.service.enqueue(claimAction(fixture)); await fixture.service.runOnce("write-crash", 1);
    await fixture.service.runOnce("write-restart", 1);
    expect(writer.calls).toHaveLength(1); expect(fixture.service.list()[0]?.state).toBe("reconciling");
  });

  it("does not replay after provider response before attempt persistence", async () => {
    const fixture = await outboxFixture(); fixtures.push(fixture); fixture.service.enqueue(claimAction(fixture));
    fixture.database.authority.db.exec("CREATE TRIGGER task29_attempt_crash BEFORE UPDATE ON memory_outbox_attempts BEGIN SELECT RAISE(ABORT,'attempt crash'); END");
    await expect(fixture.service.runOnce("response-crash", 1)).rejects.toThrow("attempt crash");
    fixture.database.authority.db.exec("DROP TRIGGER task29_attempt_crash");
    fixture.clock.now = new Date(fixture.clock.now.getTime() + 10_000);
    await fixture.service.runOnce("response-restart", 1);
    expect(fixture.writer.calls).toHaveLength(1); expect(fixture.service.list()[0]?.state).toBe("reconciling");
  });

  it("preserves an accepted attempt if reconciling persistence crashes", async () => {
    const fixture = await outboxFixture(); fixtures.push(fixture); fixture.service.enqueue(claimAction(fixture));
    fixture.database.authority.db.exec("CREATE TRIGGER task29_reconcile_crash BEFORE UPDATE ON memory_outbox WHEN NEW.state='reconciling' BEGIN SELECT RAISE(ABORT,'reconcile crash'); END");
    await expect(fixture.service.runOnce("persist-crash", 1)).rejects.toThrow("reconcile crash");
    expect(fixture.database.authority.db.prepare("SELECT outcome FROM memory_outbox_attempts").get()).toEqual({ outcome: "accepted" });
    fixture.database.authority.db.exec("DROP TRIGGER task29_reconcile_crash");
    fixture.clock.now = new Date(fixture.clock.now.getTime() + 10_000);
    await fixture.service.runOnce("persist-restart", 1);
    expect(fixture.writer.calls).toHaveLength(1); expect(fixture.service.list()[0]?.state).toBe("reconciling");
  });
});
