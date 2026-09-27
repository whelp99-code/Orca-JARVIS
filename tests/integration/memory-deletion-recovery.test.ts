import { describe, expect, it, vi } from "vitest";
import { MemoryTombstoneChain } from "../../src/memory-tombstone-chain.js";
import { MemoryCorrectionSaga } from "../../src/memory-correction-saga.js";
import { MemoryDeletionSaga } from "../../src/memory-deletion-saga.js";
import { MemoryDeletionStore } from "../../src/memory-deletion-store.js";
import { MemoryLifecycleBarriers } from "../../src/memory-lifecycle-barriers.js";
import { MemoryDestructiveDispatchCursor } from "../../src/memory-destructive-dispatch.js";
import { ProductionMemoryLifecycleService } from "../../src/memory-lifecycle-service.js";
import { deletionPreparedFixture, deletionObservation } from "../fixtures/memory-deletion-recovery.js";

class Crash extends Error {}

describe("production deletion restart recovery", () => {
  it("resumes mixed lanes in permanent tombstone order rather than correction priority", async () => {
    // Given: deletion sequence one and correction sequence two both died before any provider frame.
    const f = await deletionPreparedFixture();
    try {
      const runtime = { ...f.runtime, barriers: new MemoryLifecycleBarriers(f.db, {
        reached: () => { throw new Crash(); },
      }) };
      await expect(new MemoryDeletionSaga(runtime).dispatch(f.claim)).rejects.toBeInstanceOf(Crash);
      const high = new MemoryTombstoneChain(f.db, f.runtime.subject_key).highWater();
      const status = vi.spyOn(runtime.provider, "generationStatus").mockResolvedValue({ kind: "data",
        value: { tombstone_sequence: high.sequence, tombstone_set_root: high.set_root } });
      try { await expect(new MemoryCorrectionSaga(runtime).dispatch(f.correction.claim)).rejects.toBeInstanceOf(Crash); }
      finally { status.mockRestore(); }
      // When: one production reconciliation cycle resumes both rows.
      await new ProductionMemoryLifecycleService(f.runtime, async () => undefined).reconcilePending(10);
      // Then: the cursor progresses in global order with no duplicate write.
      expect(f.writer.calls.map(request => request.lane)).toEqual(["deletion", "correction"]);
      expect(f.db.db.prepare("SELECT accepted_through_sequence FROM memory_effect_dispatch_cursor").get())
        .toEqual({ accepted_through_sequence: 2 });
    } finally { await f.close(); }
  });
  it.each(["queued", "applying"] as const)("resumes %s under the original permanent tombstone", async state => {
    // Given: persisted deletion authority with its receipt already redeemed.
    const f = await deletionPreparedFixture();
    try {
      const crashing = new MemoryDeletionSaga({ ...f.runtime,
        barriers: new MemoryLifecycleBarriers(f.db, { reached: () => { throw new Crash(); } }) });
      await expect(crashing.dispatch(f.claim)).rejects.toBeInstanceOf(Crash);
      const store = new MemoryDeletionStore(f.db);
      const before = store.get("deletion:recovery");
      if (before?.lane_id === null || before?.request_digest === null || before?.tombstone_sequence === null
        || before === undefined) throw new Error("DELETION_IDENTITY_MISSING");
      if (state === "applying") {
        new MemoryDestructiveDispatchCursor(f.db).claim({ lane: "deletion", lane_id: before.lane_id,
          request_digest: before.request_digest, sequence: before.tombstone_sequence }, f.runtime.clock());
        store.begin(before.deletion_id, f.runtime.clock());
      }
      f.setTime(new Date(f.runtime.clock().getTime() + 1_000));
      // When: only production reconciliation runs after restart.
      await new ProductionMemoryLifecycleService(f.runtime, async () => undefined).reconcilePending(10);
      // Then: it resumes once, without appending a tombstone or requiring another owner approval.
      expect(store.get(before.deletion_id)?.state).toBe("reconciling");
      expect(f.writer.calls.map(request => ({ request_id: request.request_id, envelope_digest: request.envelope_digest,
        idempotency_key: request.idempotency_key }))).toEqual([{ request_id: before.request_id,
        envelope_digest: before.envelope_digest, idempotency_key: before.provider_idempotency_key }]);
      expect(f.db.db.prepare("SELECT count(*) AS count FROM memory_tombstone_chain").get()).toEqual({ count: 1 });
      expect(f.db.db.prepare("SELECT count(*) AS count FROM memory_deletion_attempts").get()).toEqual({ count: 1 });
    } finally { await f.close(); }
  });

  it.each(["live", "expired", "stale"] as const)("recovers the exact purge with a %s claim after a settlement crash", async claim => {
    // Given: completed physical erasure with no settlement yet.
    const f = await deletionPreparedFixture();
    try {
      const row = await f.saga.dispatch(f.claim);
      f.setObservation(deletionObservation(f, row));
      const crashing = new MemoryDeletionSaga({ ...f.runtime,
        barriers: new MemoryLifecycleBarriers(f.db, { reached(event) {
          if (event.barrier_id === "before_settlement_commit") throw new Crash();
        } }) });
      await expect(crashing.reconcile(row.deletion_id)).rejects.toBeInstanceOf(Crash);
      f.runtime.observer.deletion = async () => { throw new Error("PROVIDER_OFFLINE_AFTER_PROOF"); };
      switch (claim) {
        case "live": break;
        case "expired":
          f.setTime(new Date(f.runtime.clock().getTime() + 120_000));
          f.control.recoverExpired(f.runtime.clock());
          break;
        case "stale":
          f.db.db.prepare("UPDATE control_command_requests SET lease_fence=lease_fence+1 WHERE request_id=?")
            .run(f.action.request_id);
          break;
      }
      const recovered: string[] = [];
      const compactor = { compact: async () => { throw new Error("SECOND_COMPACTION_FORBIDDEN"); },
        recover: async (purgeId: string) => { recovered.push(purgeId); return f.runtime.compactor.recover(purgeId); } };
      // When: restarted production reconciliation runs twice.
      const lifecycle = new ProductionMemoryLifecycleService({ ...f.runtime, compactor }, async () => undefined);
      if (claim === "stale") {
        await expect(lifecycle.reconcilePending(10)).rejects.toMatchObject({ code: "MEMORY_DELETION_CONTROL_EVIDENCE_INVALID" });
        expect(new MemoryDeletionStore(f.db).get(row.deletion_id)?.state).toBe("provider_proved");
        expect(f.db.db.prepare("SELECT count(*) AS count FROM control_command_effects WHERE request_id=?")
          .get(f.action.request_id)).toEqual({ count: 0 });
        return;
      }
      await lifecycle.reconcilePending(10);
      await lifecycle.reconcilePending(10);
      // Then: one original purge, settlement, redemption and authority effect remain.
      expect(recovered).toHaveLength(1);
      expect(new MemoryDeletionStore(f.db).get(row.deletion_id)?.state).toBe("settled");
      expect(f.db.db.prepare("SELECT count(*) AS count FROM memory_purge_jobs").get()).toEqual({ count: 1 });
      expect(f.db.db.prepare("SELECT count(*) AS count FROM memory_deletion_events WHERE event_type='settled'").get())
        .toEqual({ count: 1 });
      expect(f.db.db.prepare("SELECT count(*) AS count FROM control_command_effects WHERE request_id=?")
        .get(f.action.request_id)).toEqual({ count: 1 });
    } finally { await f.close(); }
  }, 15_000);
});
