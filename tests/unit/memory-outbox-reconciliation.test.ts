import { afterEach, describe, expect, it } from "vitest";
import { closeMemoryDatabase } from "../fixtures/memory-candidate-store.js";
import { claimAction, evidence, FixtureReader, outboxFixture, type OutboxFixture } from "../fixtures/memory-outbox-fixture.js";
const fixtures: OutboxFixture[] = [];
afterEach(() => { for (const fixture of fixtures.splice(0)) closeMemoryDatabase(fixture.database); });
describe("memory outbox bounded reconciliation", () => {
  it("opens conflict for the exact selector with a changed digest", async () => {
    const wrong = `sha256:${"b".repeat(64)}`;
    const fixture = await outboxFixture({ reader: new FixtureReader({ kind: "current", checked_at: "2026-08-28T12:00:00.000Z", evidence: [evidence(wrong)] }) }); fixtures.push(fixture);
    const queued = fixture.service.enqueue(claimAction(fixture)); await fixture.service.runOnce("worker", 1);
    expect(fixture.service.get(queued.outbox_id)).toMatchObject({ state: "conflict", failure_code: "ARTIFACT_DIGEST_MISMATCH" });
  });

  it("records one timeout and remains reconciling until a later observation", async () => {
    const fixture = await outboxFixture({ deadline: 30_000 }); fixtures.push(fixture);
    const queued = fixture.service.enqueue(claimAction(fixture)); await fixture.service.runOnce("worker", 1);
    fixture.clock.now = new Date(fixture.clock.now.getTime() + 30_000);
    await fixture.service.reconcileOnce("worker-late", 1);
    expect(fixture.service.get(queued.outbox_id)).toMatchObject({ state: "reconciling", failure_code: "RECONCILE_TIMEOUT" });
    expect((fixture.database.authority.db.prepare("SELECT COUNT(*) AS n FROM memory_reconciliation_events WHERE event_type='reconcile_timeout'").get() as { n: number }).n).toBe(1);
  });
});
