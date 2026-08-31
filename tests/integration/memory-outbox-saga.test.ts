import { afterEach, describe, expect, it } from "vitest";
import { closeMemoryDatabase } from "../fixtures/memory-candidate-store.js";
import { claimAction, evidence, FixtureReader, OUTBOX_ARTIFACT_DIGEST, outboxFixture, type OutboxFixture } from "../fixtures/memory-outbox-fixture.js";

const fixtures: OutboxFixture[] = [];
afterEach(() => { for (const fixture of fixtures.splice(0)) closeMemoryDatabase(fixture.database); });
describe("memory outbox V2 saga", () => {
  it("dispatches once, observes the exact artifact, and settles once", async () => {
    const digest = OUTBOX_ARTIFACT_DIGEST;
    const fixture = await outboxFixture({ reader: new FixtureReader({ kind: "current", checked_at: "2026-08-28T12:00:00.000Z", evidence: [evidence(digest)] }) }); fixtures.push(fixture);
    const queued = fixture.service.enqueue(claimAction(fixture)); expect(queued.state).toBe("queued");
    const result = await fixture.service.runOnce("worker-one", 1);
    expect(result).toMatchObject({ dispatched: 1, settled: 1 });
    expect(fixture.writer.calls).toHaveLength(1);
    expect(fixture.service.get(queued.outbox_id)).toMatchObject({ state: "settled", settlement_receipt_digest: expect.stringMatching(/^sha256:/) });
    await fixture.service.runOnce("worker-two", 1); expect(fixture.writer.calls).toHaveLength(1);
  });

  it("never settles provider acceptance without an artifact", async () => {
    const fixture = await outboxFixture(); fixtures.push(fixture); const queued = fixture.service.enqueue(claimAction(fixture));
    await fixture.service.runOnce("worker-one", 1);
    expect(fixture.service.get(queued.outbox_id)).toMatchObject({ state: "reconciling", settlement_receipt_digest: null });
    expect(fixture.writer.calls).toHaveLength(1);
  });
});
