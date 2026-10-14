import { afterEach, describe, expect, it, vi } from "vitest";
import { ControlPlane } from "../../src/control-plane.js";
import { JarvisError } from "../../src/jarvis-error.js";
import { MemoryCandidateReviewSpool } from "../../src/memory-candidate-review-spool.js";
import { MemoryOutboxStore } from "../../src/memory-outbox-store.js";
import { MemoryOutboxTick } from "../../src/memory-outbox-tick.js";
import type { MemoryOutboxFailure } from "../../src/memory-outbox-diagnostic.js";
import { closeMemoryDatabase } from "../fixtures/memory-candidate-store.js";
import { claimAction, evidence, FixtureReader, OUTBOX_ARTIFACT_DIGEST, outboxFixture,
  type OutboxFixture } from "../fixtures/memory-outbox-fixture.js";

const ready = { kind: "current" as const, checked_at: "2026-08-31T03:30:00.000Z",
  evidence: [evidence(OUTBOX_ARTIFACT_DIGEST)] };
const fixtures: OutboxFixture[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const f of fixtures.splice(0)) closeMemoryDatabase(f.database);
});

describe("saga-correlated outbox diagnostic recovery", () => {
  it("recovers an idle tick from its writer saga's terminal evidence committed by another worker", async () => {
    const writer = await outboxFixture({ deadline: 60_000 });
    fixtures.push(writer);
    const queued = writer.service.enqueue(claimAction(writer));
    vi.spyOn(writer.writer, "write").mockRejectedValue(new Error("PRIVATE_SENTINEL"));
    const logs: (MemoryOutboxFailure | null)[] = [];
    const cycles: Awaited<ReturnType<typeof writer.service.runOnce>>[] = [];
    const tick = new MemoryOutboxTick(async () => {
      const cycle = await writer.service.runOnce("idle-owner", 1);
      cycles.push(cycle); return cycle;
    }, failure => logs.push(failure));
    try {
      tick.tick(); await tick.drain();
      const other = await outboxFixture({ database: writer.database, suffix: "-observer", reader: new FixtureReader(ready) });
      expect((await other.service.reconcileOnce("independent-worker", 1)).settled).toBe(1);

      tick.tick(); await tick.drain(); tick.tick(); await tick.drain();

      expect(writer.service.get(queued.outbox_id)?.state).toBe("settled");
      expect(cycles.at(-1)?.settled).toBe(0);
      expect(cycles.at(-1)?.dispatched).toBe(0);
      expect(cycles.at(-1)?.commands_reconciled).toBe(0);
      expect(logs).toEqual([expect.objectContaining({ phase: "provider_write" }), null]);
      expect(other.writer.calls).toHaveLength(0);
    } finally { await tick.close(); }
  });

  it.each(["provider_observation", "record_observation", "settlement"] as const)(
    "retains A's %s failure while B succeeds and until A's phase commits", async phase => {
      const a = await outboxFixture({ deadline: 60_000,
        reader: phase === "settlement" ? new FixtureReader(ready) : new FixtureReader({
          kind: "no_data", checked_at: ready.checked_at, fresh_until: "2026-08-31T03:31:00.000Z",
        }) });
      fixtures.push(a);
      const queuedA = a.service.enqueue(claimAction(a));
      const error = new JarvisError("MEMORY_OUTBOX_STALE_FENCE", "PRIVATE_SENTINEL");
      let reads = 0;
      Object.defineProperty(error, "code", { get: () => ++reads === 1 ? "MEMORY_OUTBOX_STALE_FENCE" : "PRIVATE_SENTINEL" });
      if (phase === "provider_observation") vi.spyOn(a.reader, "recentChanges").mockRejectedValueOnce(error);
      else vi.spyOn(MemoryOutboxStore.prototype, "recordObservation").mockImplementationOnce(() => { throw error; });
      const logs: (MemoryOutboxFailure | null)[] = [];
      const tick = new MemoryOutboxTick(() => a.service.runOnce("correlated-worker", 1), failure => logs.push(failure));
      try {
        tick.tick(); await tick.drain();
        expect(logs).toEqual([{ phase, error_code: phase === "provider_observation"
          ? "MEMORY_OUTBOX_PROVIDER_OBSERVATION_FAILED" : phase === "record_observation"
            ? "MEMORY_OUTBOX_RECORD_OBSERVATION_FAILED" : "MEMORY_OUTBOX_SETTLEMENT_FAILED",
        cause_code: "MEMORY_OUTBOX_STALE_FENCE" }]);
        expect(reads).toBe(1);
        const b = await outboxFixture({ database: a.database, suffix: "-b", deadline: 60_000 });
        const queuedB = a.service.enqueue(claimAction(b));
        vi.spyOn(a.reader, "recentChanges").mockResolvedValue(ready);
        vi.spyOn(a.reader, "readPage").mockResolvedValue(ready);
        tick.tick(); await tick.drain();
        expect(a.service.get(queuedB.outbox_id)?.state).toBe("settled");
        expect(a.service.get(queuedA.outbox_id)?.state).toBe("reconciling");
        expect(logs).toHaveLength(1);
        a.clock.now = new Date(a.clock.now.getTime() + 10_000);
        if (phase === "settlement") {
          vi.mocked(a.reader.readPage).mockResolvedValue({ kind: "no_data", checked_at: ready.checked_at,
            fresh_until: "2026-08-31T03:31:00.000Z" });
          vi.mocked(a.reader.recentChanges).mockResolvedValue({ kind: "no_data", checked_at: ready.checked_at,
            fresh_until: "2026-08-31T03:31:00.000Z" });
          tick.tick(); await tick.drain();
          expect(a.service.get(queuedA.outbox_id)?.state).toBe("reconciling");
          expect(logs).toHaveLength(1);
          vi.mocked(a.reader.recentChanges).mockResolvedValue(ready);
          vi.mocked(a.reader.readPage).mockResolvedValue(ready);
        }
        tick.tick(); await tick.drain(); tick.tick(); await tick.drain();
        expect(a.service.get(queuedA.outbox_id)?.state).toBe("settled");
        expect(logs).toEqual([expect.objectContaining({ phase, cause_code: "MEMORY_OUTBOX_STALE_FENCE" }), null]);
        expect(a.writer.calls).toHaveLength(2);
        expect(JSON.stringify(logs)).not.toContain("PRIVATE_SENTINEL");
      } finally { await tick.close(); }
    });

  it.each(["cleanup", "control"] as const)("retains writer failure across coincident %s failure and recovery", async kind => {
    const terminal = await outboxFixture({ reader: new FixtureReader(ready), suffix: "-terminal", deadline: 60_000 });
    fixtures.push(terminal);
    const terminalClaim = claimAction(terminal);
    terminal.service.enqueue(terminalClaim);
    const recovery = kind === "cleanup"
      ? vi.spyOn(MemoryCandidateReviewSpool.prototype, "remove").mockImplementation(() => { throw new Error("PRIVATE_SENTINEL"); })
      : vi.spyOn(ControlPlane.prototype, "reconcileMemoryOutbox").mockImplementation(() => {
        throw new JarvisError("MEMORY_OUTBOX_CONTROL_EVIDENCE_INVALID");
      });
    expect((await terminal.service.runOnce("terminal-seed", 1)).settled).toBe(1);
    new ControlPlane(terminal.database.authority).settle(terminal.commandId, terminalClaim.fence, {
      state: "uncertain", effect_type: "memory.outbox.reconciling", payload: {},
      failure_code: "MEMORY_OUTBOX_RECONCILING",
    }, terminal.clock.now);
    const writer = await outboxFixture({ database: terminal.database, suffix: "-writer", deadline: 60_000 });
    const queued = writer.service.enqueue(claimAction(writer));
    const write = writer.writer.write.bind(writer.writer);
    vi.spyOn(writer.writer, "write").mockImplementation(async request => { await write(request); throw new Error("PRIVATE_SENTINEL"); });
    const logs: (MemoryOutboxFailure | null)[] = [];
    const cycles: Awaited<ReturnType<typeof writer.service.runOnce>>[] = [];
    const tick = new MemoryOutboxTick(async () => {
      const result = await writer.service.runOnce("coincident-worker", 1);
      cycles.push(result); return result;
    }, failure => logs.push(failure));
    try {
      tick.tick(); await tick.drain();
      expect(cycles[0]?.failure?.phase).toBe("provider_write");
      expect(kind === "cleanup" ? cycles[0]?.cleanup_error : cycles[0]?.control_error).toBeDefined();
      recovery.mockRestore();
      tick.tick(); await tick.drain();
      expect(writer.service.get(queued.outbox_id)?.state).toBe("reconciling");
      expect(cycles.at(-1)?.failure?.phase).toBe("provider_write");
      expect(logs).toEqual([{ phase: "provider_write", error_code: "MEMORY_OUTBOX_PROVIDER_WRITE_FAILED",
        cause_code: "MEMORY_OUTBOX_UNCLASSIFIED_ERROR" }]);
      vi.spyOn(writer.reader, "recentChanges").mockResolvedValue(ready);
      vi.spyOn(writer.reader, "readPage").mockResolvedValue(ready);
      tick.tick(); await tick.drain(); tick.tick(); await tick.drain();
      expect(writer.service.get(queued.outbox_id)?.state).toBe("settled");
      expect(logs).toEqual([expect.objectContaining({ phase: "provider_write" }), null]);
      expect(writer.writer.calls).toHaveLength(1);
    } finally { await tick.close(); }
  });
});
