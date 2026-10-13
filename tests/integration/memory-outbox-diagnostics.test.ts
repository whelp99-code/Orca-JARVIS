import { afterEach, describe, expect, it, vi } from "vitest";
import { JarvisError } from "../../src/jarvis-error.js";
import { MemoryOutboxStore } from "../../src/memory-outbox-store.js";
import { MemoryOutboxTick } from "../../src/memory-outbox-tick.js";
import { memoryOutboxLog } from "../../src/memory-outbox-diagnostic.js";
import { closeMemoryDatabase } from "../fixtures/memory-candidate-store.js";
import { claimAction, evidence, FixtureReader, OUTBOX_ARTIFACT_DIGEST, outboxFixture,
  type OutboxFixture } from "../fixtures/memory-outbox-fixture.js";

const fixtures: OutboxFixture[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const fixture of fixtures.splice(0)) closeMemoryDatabase(fixture.database);
});
describe("memory outbox failure diagnostics", () => {
  it.each(["provider_observation", "record_observation", "settlement"] as const)(
    "reports %s without committing an observation or dispatching twice", async phase => {
      const fixture = await outboxFixture(phase === "settlement" ? { reader: new FixtureReader({
        kind: "current", checked_at: "2026-08-28T12:00:00.000Z", evidence: [evidence(OUTBOX_ARTIFACT_DIGEST)],
      }) } : {});
      fixtures.push(fixture);
      const queued = fixture.service.enqueue(claimAction(fixture));
      const error = new JarvisError("MEMORY_OUTBOX_STALE_FENCE", "PRIVATE_SENTINEL /qa/private/path");
      if (phase === "provider_observation") vi.spyOn(fixture.reader, "recentChanges").mockRejectedValue(error);
      else vi.spyOn(MemoryOutboxStore.prototype, "recordObservation").mockImplementation(() => { throw error; });
      const logs: unknown[] = [];
      const tick = new MemoryOutboxTick(() => fixture.service.runOnce("diagnostic-worker", 1),
        failure => logs.push(memoryOutboxLog(failure)));
      tick.tick(); await tick.drain();
      tick.tick(); await tick.drain(); // Same real service: the reconciliation lease makes this cycle idle.
      fixture.clock.now = new Date(fixture.clock.now.getTime() + 10_000);
      tick.tick(); await tick.close();
      const errorCodes = { provider_observation: "MEMORY_OUTBOX_PROVIDER_OBSERVATION_FAILED",
        record_observation: "MEMORY_OUTBOX_RECORD_OBSERVATION_FAILED", settlement: "MEMORY_OUTBOX_SETTLEMENT_FAILED" };
      expect(logs).toEqual([{ component: "memory.outbox", phase, error_code: errorCodes[phase],
        cause_code: "MEMORY_OUTBOX_STALE_FENCE" }]);
      expect(fixture.writer.calls).toHaveLength(1);
      expect(fixture.service.get(queued.outbox_id)?.state).toBe("reconciling");
      expect(fixture.database.authority.db.prepare(
        "SELECT COUNT(*) AS n FROM memory_reconciliation_events WHERE event_type IN ('artifact_missing','artifact_observed','settled')",
      ).get()).toEqual({ n: 0 });
    });
  it("propagates an unexpected primitive dispatch failure without sending to the provider", async () => {
    const fixture = await outboxFixture();
    fixtures.push(fixture);
    const queued = fixture.service.enqueue(claimAction(fixture));
    vi.spyOn(MemoryOutboxStore.prototype, "markDispatch").mockImplementation(() => { throw "PRIVATE_SENTINEL"; });
    const cycle = fixture.service.runOnce("unexpected-dispatch-worker", 1);
    await expect(cycle).rejects.toBeInstanceOf(Error);
    await expect(cycle).rejects.not.toBeInstanceOf(JarvisError);
    expect(fixture.writer.calls).toHaveLength(0);
    expect(fixture.service.get(queued.outbox_id)?.state).toBe("claimed");
  });
  it("attributes a primitive provider observation without retaining the thrown value", async () => {
    const fixture = await outboxFixture();
    fixtures.push(fixture);
    fixture.service.enqueue(claimAction(fixture));
    const marker = "PRIVATE_SENTINEL /qa/private/path";
    vi.spyOn(fixture.reader, "recentChanges").mockRejectedValue(marker);
    const logs: unknown[] = [];
    const tick = new MemoryOutboxTick(() => fixture.service.runOnce("primitive-worker", 1),
      failure => logs.push(memoryOutboxLog(failure)));
    tick.tick(); await tick.close();
    expect(logs).toEqual([{ component: "memory.outbox", phase: "provider_observation",
      error_code: "MEMORY_OUTBOX_PROVIDER_OBSERVATION_FAILED", cause_code: "MEMORY_OUTBOX_UNCLASSIFIED_ERROR" }]);
    expect(JSON.stringify(logs)).not.toContain("PRIVATE_SENTINEL");
    expect(fixture.writer.calls).toHaveLength(1);
  });
  it("clears a prior failure after lease expiry commits artifact_missing only", async () => {
    const fixture = await outboxFixture();
    fixtures.push(fixture);
    const queued = fixture.service.enqueue(claimAction(fixture));
    let observations = 0;
    vi.spyOn(fixture.reader, "recentChanges").mockImplementation(() => {
      observations += 1;
      if (observations === 1) return Promise.reject(new JarvisError("MEMORY_READ_FENCE_KEY_UNAVAILABLE"));
      return Promise.resolve(fixture.reader.outcome);
    });
    const logs: unknown[] = [];
    const tick = new MemoryOutboxTick(() => fixture.service.runOnce("recover-worker", 1),
      failure => logs.push(memoryOutboxLog(failure)));
    tick.tick(); await tick.drain();
    tick.tick(); await tick.drain();
    fixture.clock.now = new Date(fixture.clock.now.getTime() + 10_000);
    tick.tick(); await tick.close();
    expect(logs).toEqual([
      { component: "memory.outbox", phase: "provider_observation",
        error_code: "MEMORY_OUTBOX_PROVIDER_OBSERVATION_FAILED", cause_code: "MEMORY_READ_FENCE_KEY_UNAVAILABLE" },
      { component: "memory.outbox", phase: null, error_code: null, cause_code: null },
    ]);
    expect(fixture.service.get(queued.outbox_id)?.state).toBe("reconciling");
    expect(fixture.database.authority.db.prepare(
      "SELECT COUNT(*) AS n FROM memory_reconciliation_events WHERE event_type='artifact_missing'",
    ).get()).toEqual({ n: 1 });
  });
  it("keeps the original settlement exception and rolls back colliding evidence", async () => {
    const fixture = await outboxFixture({ reader: new FixtureReader({ kind: "current",
      checked_at: "2026-08-28T12:00:00.000Z", evidence: [evidence(OUTBOX_ARTIFACT_DIGEST)] }) });
    fixtures.push(fixture);
    const queued = fixture.service.enqueue(claimAction(fixture));
    fixture.database.authority.db.exec(`CREATE TRIGGER diagnostic_settlement_collision BEFORE INSERT ON memory_reconciliation_events
      WHEN NEW.event_type='settled' BEGIN
        INSERT INTO memory_reconciliation_events(event_id,outbox_id,attempt_id,reconcile_fence,event_type,effect_digest,created_at)
        VALUES('event:diagnostic-collision',NEW.outbox_id,NEW.attempt_id,NEW.reconcile_fence,NEW.event_type,NEW.effect_digest,NEW.created_at);
        SELECT RAISE(IGNORE); END`);
    const logs: unknown[] = [];
    const tick = new MemoryOutboxTick(() => fixture.service.runOnce("collision-worker", 1),
      failure => logs.push(memoryOutboxLog(failure)));
    tick.tick(); await tick.close();
    expect(logs).toEqual([{ component: "memory.outbox", phase: "settlement",
      error_code: "MEMORY_OUTBOX_SETTLEMENT_FAILED", cause_code: "MEMORY_OUTBOX_EVIDENCE_CONFLICT" }]);
    expect(fixture.service.get(queued.outbox_id)?.state).toBe("reconciling");
    expect(fixture.database.authority.db.prepare(
      "SELECT COUNT(*) AS n FROM memory_reconciliation_events WHERE event_type='settled'",
    ).get()).toEqual({ n: 0 });
  });
});
