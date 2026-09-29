import Database from "better-sqlite3";
import { statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MemoryCorrectionSaga } from "../../src/memory-correction-saga.js";
import { MemoryCorrectionStore } from "../../src/memory-correction-store.js";
import { MemoryLifecycleBarriers } from "../../src/memory-lifecycle-barriers.js";
import { ProductionMemoryLifecycleService } from "../../src/memory-lifecycle-service.js";
import { correctionPreparedFixture, correctionObservation } from "../fixtures/memory-correction-control.js";

class Crash extends Error {}

describe("Task30 persisted recovery", () => {
  it("does not replay a live dispatch when reconciliation overlaps execution", async () => {
    // Given: the provider write is in flight behind an exact event barrier.
    const f = await correctionPreparedFixture();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const jobs: Promise<unknown>[] = [];
    const service = new ProductionMemoryLifecycleService({ ...f.runtime, writer: {
      async write(value: unknown) { entered.resolve(); await release.promise; return f.writer.write(value); },
    } }, async () => undefined);
    try {
      jobs.push(service.execute(f.claim));
      await entered.promise;
      // When: the pending cycle overlaps the active command, then its provider acceptance arrives.
      jobs.push(service.reconcilePending(10));
      release.resolve();
      await Promise.all(jobs);
      // Then: recovery did not create a second frame/effect for the live dispatch.
      expect(f.writer.calls).toHaveLength(1);
    } finally { release.resolve(); await Promise.allSettled(jobs); await f.close(); }
  });
  it("resumes the original queued request when approval was already redeemed", async () => {
    // Given: the exact durable barrier before any frame leaves JARVIS.
    const f = await correctionPreparedFixture();
    try {
      const crashing = new MemoryCorrectionSaga({ ...f.runtime,
        barriers: new MemoryLifecycleBarriers(f.db, { reached: () => { throw new Crash(); } }) });
      await expect(crashing.dispatch(f.claim)).rejects.toBeInstanceOf(Crash);
      const store = new MemoryCorrectionStore(f.db);
      const before = store.getByControl(f.action.request_id);
      if (!before?.spool_locator) throw new Error("QUEUED_SPOOL_MISSING");
      expect(statSync(join(f.runtime.spool_root, before.spool_locator)).mode & 0o777).toBe(0o600);
      expect(() => f.control.claim(f.action.request_id, "restart", f.runtime.clock()))
        .toThrow("CONTROL_APPROVAL_REQUIRED");
      f.setTime(new Date(f.runtime.clock().getTime() + 1_000));

      // When: a fresh production reconciler observes persisted work, without a new approval.
      const restarted = new ProductionMemoryLifecycleService(f.runtime, async () => undefined);
      await restarted.reconcilePending(10);

      // Then: one original request is sent, one tombstone remains, and no authority is redeemed again.
      expect(store.get(before.correction_id)?.state).toBe("reconciling");
      expect(f.writer.calls.map(request => ({ request_id: request.request_id,
        idempotency_key: request.idempotency_key, envelope_digest: request.envelope_digest })))
        .toEqual([{ request_id: before.request_id, idempotency_key: before.idempotency_key,
          envelope_digest: before.envelope_digest }]);
      expect(f.db.db.prepare("SELECT count(*) AS count FROM memory_tombstone_chain").get()).toEqual({ count: 1 });
      expect(f.db.db.prepare("SELECT count(*) AS count FROM control_command_redemptions WHERE request_id=?")
        .get(f.action.request_id)).toEqual({ count: 1 });
    } finally { await f.close(); }
  });

  it("recovers an existing purge job instead of starting a second compaction", async () => {
    // Given: a real physical compaction completed before settlement, then restart resumes the job.
    const f = await correctionPreparedFixture();
    try {
      const record = await f.saga.dispatch(f.claim);
      f.setObservation(correctionObservation({ ...f, record }));
      const crashing = new MemoryCorrectionSaga({ ...f.runtime,
        barriers: new MemoryLifecycleBarriers(f.db, { reached(event) {
          if (event.barrier_id === "before_settlement_commit") throw new Crash();
        } }) });
      await expect(crashing.reconcile(record.correction_id)).rejects.toBeInstanceOf(Crash);
      const calls: string[] = [];
      const compactor = { compact: f.runtime.compactor.compact.bind(f.runtime.compactor),
        recover: async (purgeId: string) => { calls.push(purgeId); return f.runtime.compactor.recover(purgeId); } };

      // When: the production pending reconciliation is restarted.
      const restarted = new ProductionMemoryLifecycleService({ ...f.runtime, compactor }, async () => undefined);
      await restarted.reconcilePending(10);

      // Then: recovery uses the durable purge identity and settles exactly once.
      expect(calls).toHaveLength(1);
      expect(new MemoryCorrectionStore(f.db).get(record.correction_id)?.state).toBe("settled");
      expect(f.db.db.prepare("SELECT count(*) AS count FROM memory_purge_jobs").get()).toEqual({ count: 1 });
      expect(f.db.db.prepare("SELECT count(*) AS count FROM memory_correction_events WHERE event_type='settled'")
        .get()).toEqual({ count: 1 });
    } finally { await f.close(); }
  }, 15_000);
});

describe("claim contention boundary", () => {
  it.each(["SQLITE_BUSY", "SQLITE_BUSY_SNAPSHOT"] as const)("returns a typed no-effect loser for %s", async code => {
    // Given: a real competing SQLite connection and an already approved control request.
    const f = await correctionPreparedFixture();
    const competitor = new Database(f.db.filename);
    f.db.db.pragma("busy_timeout=0");
    try {
      if (code === "SQLITE_BUSY") competitor.exec("BEGIN IMMEDIATE");
      else {
        f.db.db.exec("BEGIN");
        f.db.db.prepare("SELECT count(*) FROM control_command_requests").get();
        competitor.prepare("UPDATE control_command_requests SET lease_owner='competing' WHERE request_id=?").run(f.action.request_id);
      }
      // When: the worker tries to claim while the other writer owns the write slot/snapshot.
      // Then: no raw SQLite error escapes and no duplicate redemption exists.
      expect(() => f.control.claim(f.action.request_id, "loser", new Date("2026-08-28T12:02:00.000Z")))
        .toThrow("CONTROL_CLAIM_RACE");
    } finally {
      if (competitor.inTransaction) competitor.exec("ROLLBACK");
      if (f.db.db.inTransaction) f.db.db.exec("ROLLBACK");
      competitor.close(); await f.close();
    }
  });
});
