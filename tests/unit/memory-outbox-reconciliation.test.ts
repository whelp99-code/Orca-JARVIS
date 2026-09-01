import { createHash } from "node:crypto";
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

  it("settles a schema-4 bound record against the frozen cited-line digest", async () => {
    const text = "ExampleAlpha.";
    const digest = `sha256:${createHash("sha256").update(text).digest("hex")}`;
    const bound = { ...evidence(digest), excerpt: text, record: {
      record_id: `sbrecord:v1:${"1".repeat(64)}`, record_digest: `sha256:${"1".repeat(64)}`,
      source_identity_full: "2".repeat(64), content_identity_full: digest.slice(7),
      citation_identity_full: "3".repeat(64), source_owner_class: "provider_owned" as const,
      source_owner_id_digest: `sha256:${"4".repeat(64)}`, origin_label: "Second Brain",
      generation: { provider_instance_id: "provider:fixture", generation_id: `sbgen:v1:${"5".repeat(64)}`,
        generation_manifest_digest: `sha256:${"6".repeat(64)}`, vault_head: "7".repeat(40),
        vault_tree: "8".repeat(40), tombstone_sequence: 0, tombstone_set_root: `sha256:${"9".repeat(64)}` },
    } };
    const fixture = await outboxFixture({ reader: new FixtureReader({ kind: "current",
      checked_at: "2026-08-28T12:00:00.000Z", evidence: [bound] }) }); fixtures.push(fixture);
    const queued = fixture.service.enqueue(claimAction(fixture));
    expect(await fixture.service.runOnce("worker", 1)).toMatchObject({ settled: 1, conflicts: 0 });
    expect(fixture.service.get(queued.outbox_id)).toMatchObject({ state: "settled", failure_code: null });
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
