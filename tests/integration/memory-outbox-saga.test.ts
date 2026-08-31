import { afterEach, describe, expect, it, vi } from "vitest";
import { snapshotSecondBrainWriteArguments } from "../../src/second-brain-write-request.js";
import { closeMemoryDatabase } from "../fixtures/memory-candidate-store.js";
import { claimAction, evidence, FixtureReader, OUTBOX_ARTIFACT_DIGEST, outboxFixture, type OutboxFixture } from "../fixtures/memory-outbox-fixture.js";

const fixtures: OutboxFixture[] = [];
afterEach(() => { for (const fixture of fixtures.splice(0)) closeMemoryDatabase(fixture.database); });
describe("memory outbox V2 saga", () => {
  it("snapshots an authorized historical request without wall-clock rejection", async () => {
    const fixture = await outboxFixture(); fixtures.push(fixture); vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-09-02T00:00:00.000Z"));
      expect(snapshotSecondBrainWriteArguments({ request: fixture.request })).toEqual({ request: fixture.request });
    } finally { vi.useRealTimers(); }
  });
  it("dispatches once, observes the exact artifact, and settles once", async () => {
    const digest = OUTBOX_ARTIFACT_DIGEST;
    const fixture = await outboxFixture({ reader: new FixtureReader({ kind: "current", checked_at: "2026-08-28T12:00:00.000Z", evidence: [evidence(digest)] }) }); fixtures.push(fixture);
    const queued = fixture.service.enqueue(claimAction(fixture)); expect(queued.state).toBe("queued");
    expect(fixture.database.authority.db.prepare("SELECT state FROM memory_candidates WHERE candidate_id=?").get(queued.candidate_id)).toEqual({ state: "queued" });
    const result = await fixture.service.runOnce("worker-one", 1);
    expect(result).toMatchObject({ dispatched: 1, settled: 1 });
    expect(fixture.writer.calls).toHaveLength(1);
    expect(fixture.service.get(queued.outbox_id)).toMatchObject({ state: "settled", settlement_receipt_digest: expect.stringMatching(/^sha256:/) });
    expect(fixture.database.authority.db.prepare("SELECT state FROM memory_candidates WHERE candidate_id=?").get(queued.candidate_id)).toEqual({ state: "settled" });
    await fixture.service.runOnce("worker-two", 1); expect(fixture.writer.calls).toHaveLength(1);
  });

  it("never settles provider acceptance without an artifact", async () => {
    const fixture = await outboxFixture(); fixtures.push(fixture); const queued = fixture.service.enqueue(claimAction(fixture));
    await fixture.service.runOnce("worker-one", 1);
    expect(fixture.service.get(queued.outbox_id)).toMatchObject({ state: "reconciling", settlement_receipt_digest: null });
    expect(fixture.writer.calls).toHaveLength(1);
  });
});
