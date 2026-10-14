import { afterEach, describe, expect, it, vi } from "vitest";
import { JarvisError } from "../../src/jarvis-error.js";
import { MemoryOutboxStore } from "../../src/memory-outbox-store.js";
import { MemoryCandidateReviewSpool } from "../../src/memory-candidate-review-spool.js";
import { MemoryOutboxTick } from "../../src/memory-outbox-tick.js";
import type { MemoryOutboxCycleResult } from "../../src/memory-outbox-types.js";
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
  it("retains an uncertain writer diagnostic through missing artifacts until terminal settlement", async () => {
    const fixture = await outboxFixture({ deadline: 60_000 });
    fixtures.push(fixture);
    const queued = fixture.service.enqueue(claimAction(fixture));
    const write = fixture.writer.write.bind(fixture.writer);
    vi.spyOn(fixture.writer, "write").mockImplementation(async request => {
      await write(request);
      throw new JarvisError("MEMORY_OUTBOX_WRITE_FAILED");
    });
    const cycles: MemoryOutboxCycleResult[] = [];
    const logs: unknown[] = [];
    const tick = new MemoryOutboxTick(async () => {
      const cycle = await fixture.service.runOnce("uncertain-recovery-worker", 1);
      cycles.push(cycle); return cycle;
    }, failure => logs.push(memoryOutboxLog(failure)));
    tick.tick(); await tick.drain();
    for (let index = 0; index < 2; index++) {
      fixture.clock.now = new Date(fixture.clock.now.getTime() + 10_000);
      tick.tick(); await tick.drain();
      expect(cycles.at(-1)?.reconciling).toBe(1);
      expect(fixture.service.get(queued.outbox_id)?.state).toBe("reconciling");
      expect(logs).toHaveLength(1);
    }
    const artifact = { kind: "current" as const, checked_at: "2026-08-31T03:30:30.000Z",
      evidence: [evidence(OUTBOX_ARTIFACT_DIGEST)] };
    vi.spyOn(fixture.reader, "recentChanges").mockResolvedValue(artifact);
    vi.spyOn(fixture.reader, "readPage").mockResolvedValue(artifact);
    fixture.clock.now = new Date(fixture.clock.now.getTime() + 10_000);

    tick.tick(); await tick.drain(); tick.tick(); await tick.close();

    expect(cycles.at(-2)?.settled).toBe(1);
    expect(fixture.service.get(queued.outbox_id)?.state).toBe("settled");
    expect(fixture.writer.calls).toHaveLength(1);
    expect(logs).toEqual([
      { component: "memory.outbox", phase: "provider_write",
        error_code: "MEMORY_OUTBOX_PROVIDER_WRITE_FAILED", cause_code: "MEMORY_OUTBOX_UNCLASSIFIED_ERROR" },
      { component: "memory.outbox", phase: null, error_code: null, cause_code: null },
    ]);
  });

  it("clears an active cleanup failure after an otherwise-idle successful retry", async () => {
    const fixture = await outboxFixture({ reader: new FixtureReader({ kind: "current",
      checked_at: "2026-08-28T12:00:00.000Z", evidence: [evidence(OUTBOX_ARTIFACT_DIGEST)] }) });
    fixtures.push(fixture);
    const queued = fixture.service.enqueue(claimAction(fixture));
    vi.spyOn(MemoryCandidateReviewSpool.prototype, "remove").mockImplementationOnce(() => {
      throw new Error("PRIVATE_SENTINEL");
    });
    const logs: unknown[] = [];
    const tick = new MemoryOutboxTick(() => fixture.service.runOnce("cleanup-retry-worker", 1),
      failure => logs.push(memoryOutboxLog(failure)));
    tick.tick(); await tick.drain();
    expect(fixture.service.get(queued.outbox_id)?.state).toBe("settled");
    tick.tick(); await tick.drain();
    tick.tick(); await tick.close();
    expect(logs).toEqual([
      { component: "memory.outbox", phase: "review_cleanup",
        error_code: "MEMORY_REVIEW_CLEANUP_FAILED", cause_code: "MEMORY_OUTBOX_UNCLASSIFIED_ERROR" },
      { component: "memory.outbox", phase: null, error_code: null, cause_code: null },
    ]);
    expect(fixture.writer.calls).toHaveLength(1);
    expect([...new MemoryCandidateReviewSpool(fixture.database.root + "/candidate-review").iteratePaths()]).toHaveLength(0);
  });
  it.each(["settled", "conflict"] as const)("omits an uncertain write failure after same-cycle %s", async terminal => {
    const fixture = await outboxFixture();
    fixtures.push(fixture);
    const queued = fixture.service.enqueue(claimAction(fixture));
    const write = fixture.writer.write.bind(fixture.writer);
    vi.spyOn(fixture.writer, "write").mockImplementation(async request => {
      await write(request);
      const artifact = { kind: "current" as const, checked_at: "2026-08-28T12:00:00.000Z",
        evidence: [evidence(terminal === "settled" ? OUTBOX_ARTIFACT_DIGEST : `sha256:${"f".repeat(64)}`)] };
      vi.spyOn(fixture.reader, "recentChanges").mockResolvedValue(artifact);
      vi.spyOn(fixture.reader, "readPage").mockResolvedValue(artifact);
      throw new JarvisError("MEMORY_OUTBOX_WRITE_FAILED");
    });
    const result = await fixture.service.runOnce("committed-uncertain-worker", 1);
    expect(terminal === "settled" ? result.settled : result.conflicts).toBe(1);
    expect(result.failure).toBeUndefined();
    expect(fixture.service.get(queued.outbox_id)?.state).toBe(terminal);
    expect(fixture.writer.calls).toHaveLength(1);
    const idle = await fixture.service.runOnce("committed-uncertain-worker", 1);
    expect(idle.settled).toBe(0);
    expect(idle.failure).toBeUndefined();
    expect(fixture.writer.calls).toHaveLength(1);
  });
  it("retains an uncertain write failure while its artifact is still missing", async () => {
    const fixture = await outboxFixture();
    fixtures.push(fixture);
    const queued = fixture.service.enqueue(claimAction(fixture));
    const write = fixture.writer.write.bind(fixture.writer);
    vi.spyOn(fixture.writer, "write").mockImplementation(async request => {
      await write(request);
      throw new JarvisError("MEMORY_OUTBOX_WRITE_FAILED");
    });
    const result = await fixture.service.runOnce("unresolved-uncertain-worker", 1);
    expect(result.settled).toBe(0);
    expect(result.failure?.phase).toBe("provider_write");
    expect(fixture.service.get(queued.outbox_id)?.state).toBe("reconciling");
    expect(fixture.writer.calls).toHaveLength(1);
  });
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
