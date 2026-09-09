import { expect, it } from "vitest";
import { settleMemoryScopedCompletion, readMemoryScopedSettlement } from "../../src/memory-scoped-settlement.js";
import { completionObservationFixture } from "../fixtures/scoped-completion-observation.js";
import { closeMemoryDatabase } from "../fixtures/memory-candidate-store.js";
import { MemoryProjectionAuthority } from "../../src/memory-projection-authority.js";
import { readMemoryScopedReconciliationRequest } from "../../src/memory-scoped-reconciliation.js";
import { readMemoryScopedCompletionProof } from "../../src/memory-scoped-completion-proof.js";

it.each(["candidate", "outbox"])("withholds historical raw bytes and replay after %s quarantine", async target => {
  const f = await completionObservationFixture();
  try {
    const roots = { candidate_dispatch_spool_root: f.options.dispatch.roots.dispatch,
      candidate_review_spool_root: f.options.dispatch.roots.review };
    await settleMemoryScopedCompletion(f.options, f.leased.lease, f.client, () => f.at, roots);
    const id = target === "candidate" ? f.candidate.candidate_id : f.leased.lease.outbox_id;
    new MemoryProjectionAuthority(f.database.authority).quarantineUnresolved({
      kind: "dashboard_projection", id, component_id: id }, f.at);
    const before = f.database.authority.db.prepare("SELECT total_changes() AS n").get();
    expect(() => readMemoryScopedReconciliationRequest(f.options, f.leased.lease.outbox_id, f.at)).toThrow();
    expect(() => readMemoryScopedCompletionProof(f.options, f.recorded.observation_id, f.at)).toThrow();
    expect(() => readMemoryScopedSettlement(f.options, f.leased.lease.outbox_id, f.at)).toThrow();
    await expect(settleMemoryScopedCompletion(f.options, f.leased.lease, f.client, () => f.at, roots)).rejects.toThrow();
    expect(f.database.authority.db.prepare("SELECT total_changes() AS n").get()).toEqual(before);
  } finally { closeMemoryDatabase(f.database); }
});

it.each(["valid", "effect_failure", "control_failure", "final_revocation", "stale"])(
  "settles memory and control atomically: %s", async mode => {
    const f = await completionObservationFixture();
    try {
      const db = f.database.authority.db, roots = { candidate_dispatch_spool_root: f.options.dispatch.roots.dispatch,
        candidate_review_spool_root: f.options.dispatch.roots.review };
      let checks = 0;
      const client = { withRememberedCompletion: async (_request: unknown, consume: any) => consume(f.observation, () => {
        if (++checks === 4 && mode === "final_revocation") db.prepare("INSERT INTO authority_revocations(reference,reason,created_at) VALUES(?,?,?)")
          .run(f.claimed.request_id, "withdrawn", f.at.toISOString());
        return f.observation;
      }) };
      if (mode === "effect_failure") db.exec("CREATE TEMP TRIGGER injected_failure BEFORE INSERT ON control_command_effects BEGIN SELECT RAISE(ABORT,'injected'); END");
      if (mode === "control_failure") db.exec("CREATE TEMP TRIGGER injected_failure AFTER UPDATE OF state ON control_command_requests WHEN NEW.state='completed' BEGIN SELECT RAISE(ABORT,'injected'); END");
      const lease = mode === "stale" ? { ...f.leased.lease, fence: f.leased.lease.fence + 1 } : f.leased.lease;
      const run = () => settleMemoryScopedCompletion(f.options, lease, client, () => f.at, roots);
      if (mode === "valid") {
        const result = await run();
        expect(result.kind).toBe("memory_scoped_settled");
        expect(result.replayed).toBe(false);
        const before = db.prepare("SELECT * FROM control_command_effects").all();
        expect(await run()).toEqual({ ...result, replayed: true });
        expect(readMemoryScopedSettlement(f.options, lease.outbox_id, new Date(f.at.getTime() + 60000))).toEqual({ ...result, replayed: true });
        expect(db.prepare("SELECT * FROM control_command_effects").all()).toEqual(before);
        expect(db.prepare("SELECT state FROM memory_candidates").get()).toEqual({ state: "settled" });
        expect(db.prepare("SELECT state FROM control_command_requests WHERE request_id=?").get(f.claimed.request_id)).toEqual({ state: "completed" });
        db.exec("CREATE TEMP VIEW control_events AS SELECT * FROM main.control_events WHERE event_type<>'control.command.completed'");
        expect(() => readMemoryScopedSettlement(f.options, lease.outbox_id, f.at)).toThrow("SCOPED_SETTLEMENT_INVALID");
        db.exec("DROP VIEW temp.control_events");
        const cancelled = new AbortController(); cancelled.abort();
        await expect(settleMemoryScopedCompletion(f.options, lease, client, () => f.at, roots, cancelled.signal))
          .rejects.toThrow("SECOND_BRAIN_CANCELLED");

      } else {
        await expect(run()).rejects.toThrow();
        expect(db.prepare("SELECT state FROM memory_outbox").get()).toEqual({ state: "reconciling" });
        expect(db.prepare("SELECT state FROM control_command_requests WHERE request_id=?").get(f.claimed.request_id)).toEqual({ state: "claimed" });
        expect(db.prepare("SELECT count(*) AS n FROM memory_scoped_settlements").get()).toEqual({ n: 0 });
        expect(db.prepare("SELECT count(*) AS n FROM memory_reconciliation_events WHERE event_type IN ('artifact_observed','settled')").get()).toEqual({ n: 0 });
      }
      expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally { closeMemoryDatabase(f.database); }
  });
