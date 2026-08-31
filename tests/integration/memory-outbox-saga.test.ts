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
    const terminal = fixture.database.authority.db.prepare(
      "SELECT event_type,effect_digest FROM memory_reconciliation_events WHERE outbox_id=? AND event_type IN ('artifact_observed','settled') ORDER BY event_type",
    ).all(queued.outbox_id) as Array<{ event_type: string; effect_digest: string }>;
    expect(terminal.map(row => row.event_type)).toEqual(["artifact_observed", "settled"]);
    expect(new Set(terminal.map(row => row.effect_digest)).size).toBe(2);
    expect(terminal.find(row => row.event_type === "settled")?.effect_digest)
      .toBe(fixture.service.get(queued.outbox_id)?.settlement_receipt_digest);
    await fixture.service.runOnce("worker-two", 1); expect(fixture.writer.calls).toHaveLength(1);
  });

  it("fails closed when required settled evidence collides", async () => {
    const fixture = await outboxFixture({ reader: new FixtureReader({ kind: "current",
      checked_at: "2026-08-28T12:00:00.000Z", evidence: [evidence(OUTBOX_ARTIFACT_DIGEST)] }) });
    fixtures.push(fixture); const queued = fixture.service.enqueue(claimAction(fixture));
    fixture.database.authority.db.exec(`CREATE TRIGGER task29_settled_collision BEFORE INSERT ON memory_reconciliation_events
      WHEN NEW.event_type='settled' BEGIN
        INSERT INTO memory_reconciliation_events(event_id,outbox_id,attempt_id,reconcile_fence,event_type,outcome_code,
          page_id,sid,source_version,observed_artifact_digest,effect_digest,created_at)
        VALUES('event:collision',NEW.outbox_id,NEW.attempt_id,NEW.reconcile_fence,NEW.event_type,NEW.outcome_code,
          NEW.page_id,NEW.sid,NEW.source_version,NEW.observed_artifact_digest,NEW.effect_digest,NEW.created_at);
        SELECT RAISE(IGNORE); END`);
    await expect(fixture.service.runOnce("collision-worker", 1)).rejects.toThrow("MEMORY_OUTBOX_EVIDENCE_CONFLICT");
    expect(fixture.service.get(queued.outbox_id)?.state).toBe("reconciling");
    expect(fixture.database.authority.db.prepare(
      "SELECT COUNT(*) AS n FROM memory_reconciliation_events WHERE outbox_id=? AND event_type='settled'",
    ).get(queued.outbox_id)).toEqual({ n: 0 });
  });

  it("never settles provider acceptance without an artifact", async () => {
    const fixture = await outboxFixture(); fixtures.push(fixture); const queued = fixture.service.enqueue(claimAction(fixture));
    await fixture.service.runOnce("worker-one", 1);
    expect(fixture.service.get(queued.outbox_id)).toMatchObject({ state: "reconciling", settlement_receipt_digest: null });
    expect(fixture.writer.calls).toHaveLength(1);
  });

  it.each(["null", "wrong", "stale", "current"] as const)("enforces a %s direct SQL settlement receipt", async mode => {
    const fixture = await outboxFixture(); fixtures.push(fixture); const queued = fixture.service.enqueue(claimAction(fixture));
    await fixture.service.runOnce("prepare-sql", 1);
    const prior = fixture.service.get(queued.outbox_id); expect(prior?.state).toBe("reconciling");
    const fence = (prior?.lease_fence ?? 0) + 1; const at = fixture.clock.now.toISOString();
    fixture.database.authority.db.prepare(
      `UPDATE memory_outbox SET lease_owner='sql-probe',lease_fence=?,lease_expires_at=?,updated_at=?
       WHERE outbox_id=? AND state='reconciling'`,
    ).run(fence, new Date(fixture.clock.now.getTime() + 10_000).toISOString(), at, queued.outbox_id);
    const attempt = fixture.database.authority.db.prepare(
      "SELECT attempt_id FROM memory_outbox_attempts WHERE outbox_id=?",
    ).get(queued.outbox_id) as { attempt_id: string };
    const insert = fixture.database.authority.db.prepare(
      `INSERT INTO memory_reconciliation_events(
        event_id,outbox_id,attempt_id,reconcile_fence,event_type,outcome_code,observed_artifact_digest,effect_digest,created_at
       ) VALUES(?,?,?,?,?,?,?,?,?)`,
    );
    insert.run(`event:sql:observed:${mode}`, queued.outbox_id, attempt.attempt_id, fence,
      "artifact_observed", "ARTIFACT_OBSERVED", queued.expected_artifact.source_digest, `sha256:${"7".repeat(64)}`, at);
    const receipt = `sha256:${"8".repeat(64)}`;
    if (mode !== "null") insert.run(`event:sql:settled:${mode}`, queued.outbox_id, attempt.attempt_id,
      mode === "stale" ? fence - 1 : fence, "settled", "ARTIFACT_OBSERVED", queued.expected_artifact.source_digest,
      mode === "wrong" ? `sha256:${"9".repeat(64)}` : receipt, at);
    const settle = () => fixture.database.authority.db.prepare(
      `UPDATE memory_outbox SET state='settled',lease_owner=NULL,lease_expires_at=NULL,
       settlement_receipt_digest=?,settled_at=?,updated_at=? WHERE outbox_id=? AND lease_fence=?`,
    ).run(mode === "null" ? null : receipt, at, at, queued.outbox_id, fence);
    if (mode === "current") {
      expect(settle).not.toThrow(); expect(fixture.service.get(queued.outbox_id)?.state).toBe("settled");
      expect(() => fixture.database.authority.db.prepare(
        "UPDATE memory_outbox SET settlement_receipt_digest=NULL WHERE outbox_id=?",
      ).run(queued.outbox_id)).toThrow("immutable memory outbox settlement");
    } else expect(settle).toThrow("memory outbox reconciliation required");
  });
});
