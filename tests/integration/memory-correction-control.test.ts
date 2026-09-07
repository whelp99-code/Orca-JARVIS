import { describe, expect, it, vi } from "vitest";
import { correctionControlFixture, correctionObservation } from "../fixtures/memory-correction-control.js";
import { MemoryCorrectionStore } from "../../src/memory-correction-store.js";
import { reconcileCorrectionControl, reconcileCorrectionControls } from "../../src/memory-correction-control.js";
import { correctionCompactionProof } from "../../src/memory-correction-compaction-proof.js";
import type { CorrectionControlRow } from "../../src/memory-correction-control-binding.js";

const NOW = new Date("2026-08-28T12:00:00.000Z");
const LATER = new Date("2026-08-28T12:20:00.000Z");
const state = (f: Awaited<ReturnType<typeof correctionControlFixture>>) => f.db.db.prepare(
  "SELECT state FROM control_command_requests WHERE request_id=?").get(f.action.request_id);

async function interrupted() {
  const f = await correctionControlFixture();
  f.setObservation(correctionObservation(f));
  const reach = f.runtime.barriers.reach.bind(f.runtime.barriers);
  const barrier = vi.spyOn(f.runtime.barriers, "reach").mockImplementation(async input => {
    if (input.barrier_id === "before_settlement_commit") throw new Error("INTERRUPTED");
    return reach(input);
  });
  await expect(f.saga.reconcile(f.record.correction_id)).rejects.toThrow("INTERRUPTED");
  barrier.mockRestore();
  return f;
}

describe("correction control completion from durable proof", () => {
  it("completes after compaction and approval/lease expiry using a fresh clock", async () => {
    const f = await correctionControlFixture();
    try {
      f.setObservation(correctionObservation(f));
      const reach = f.runtime.barriers.reach.bind(f.runtime.barriers);
      vi.spyOn(f.runtime.barriers, "reach").mockImplementation(async input => {
        if (input.barrier_id === "before_settlement_commit") f.setTime(LATER);
        return reach(input);
      });
      expect((await f.saga.reconcile(f.record.correction_id)).state).toBe("settled");
      expect(state(f)).toEqual({ state: "completed" });
      expect(f.db.db.prepare("SELECT settled_at FROM memory_correction_requests").get()).toEqual({ settled_at: LATER.toISOString() });
      expect(f.db.db.prepare("SELECT target_json,args_json FROM control_command_requests WHERE request_id=?")
        .get(f.action.request_id)).toEqual({ target_json: '{"purged":true}', args_json: '{"purged":true}' });
      const observer = vi.spyOn(f.runtime.observer,"correction").mockRejectedValue(new Error("OFFLINE"));
      await f.saga.reconcile(f.record.correction_id);
      expect(observer).not.toHaveBeenCalled(); expect(f.writer.calls).toHaveLength(1);
      expect(f.db.db.prepare("SELECT count(*) n FROM control_command_effects WHERE request_id=?")
        .get(f.action.request_id)).toEqual({ n: 1 });
    } finally { await f.close(); }
  });

  it("rolls back a failed final event, then recovers locally while provider is offline", async () => {
    const f = await interrupted();
    try {
      const observer = vi.spyOn(f.runtime.observer,"correction").mockRejectedValue(new Error("OFFLINE"));
      const compact = vi.spyOn(f.runtime.compactor,"compact");
      f.db.db.exec(`CREATE TRIGGER fail_completion BEFORE INSERT ON control_events
        WHEN NEW.event_type='control.command.completed' BEGIN SELECT RAISE(ABORT,'EVENT_FAILED'); END;`);
      await expect(f.saga.reconcile(f.record.correction_id)).rejects.toThrow("EVENT_FAILED");
      expect(state(f)).toEqual({ state: "claimed" });
      expect(new MemoryCorrectionStore(f.db).get(f.record.correction_id)?.state).toBe("provider_proved");
      expect(f.db.db.prepare("SELECT count(*) n FROM control_command_effects WHERE request_id=?")
        .get(f.action.request_id)).toEqual({ n: 0 });
      f.db.db.exec("DROP TRIGGER fail_completion"); f.setTime(LATER);
      await f.saga.reconcile(f.record.correction_id);
      expect(state(f)).toEqual({ state: "completed" });
      expect(observer).not.toHaveBeenCalled(); expect(compact).not.toHaveBeenCalled();
      expect(f.writer.calls).toHaveLength(1);
    } finally { await f.close(); }
  });

  it.each(["claimed", "uncertain"])("repairs a historical settled/%s gap and rolls back a cursor failure", async prior => {
    const f = await interrupted();
    try {
      const receipt = correctionCompactionProof(f.db, f.record as CorrectionControlRow, NOW)!;
      new MemoryCorrectionStore(f.db).settle(f.record.correction_id, receipt.digest, NOW);
      if (prior === "uncertain") f.db.db.prepare("UPDATE control_command_requests SET state='uncertain' WHERE request_id=?")
        .run(f.action.request_id);
      f.db.db.exec("CREATE TRIGGER fail_cursor BEFORE INSERT ON memory_correction_control_cursor BEGIN SELECT RAISE(ABORT,'CURSOR_FAILED'); END;");
      expect(reconcileCorrectionControls(f.db,LATER,1)).toEqual({ correction_controls_reconciled: 0,
        correction_control_error: "MEMORY_CORRECTION_CONTROL_RECONCILE_FAILED" });
      expect(state(f)).toEqual({ state: prior });
      f.db.db.exec("DROP TRIGGER fail_cursor");
      expect(reconcileCorrectionControls(f.db,LATER,1)).toEqual({ correction_controls_reconciled: 1 });
      expect(reconcileCorrectionControls(f.db,LATER,1)).toEqual({ correction_controls_reconciled: 0 });
      expect(state(f)).toEqual({ state: "completed" }); expect(f.writer.calls).toHaveLength(1);
    } finally { await f.close(); }
  });

  it.each(["provider_key", "fence", "cancel", "revocation", "missing_binding", "proof_signature", "purge_digest"])("does not complete with %s evidence loss", async loss => {
    const f = await interrupted();
    try {
      const receipt = correctionCompactionProof(f.db, f.record as CorrectionControlRow, NOW)!;
      new MemoryCorrectionStore(f.db).settle(f.record.correction_id, receipt.digest, NOW);
      if (loss === "provider_key") f.db.db.prepare("UPDATE memory_provider_proof_keys SET state='revoked'").run();
      if (loss === "fence") f.db.db.prepare("UPDATE control_command_requests SET lease_fence=lease_fence+1 WHERE request_id=?").run(f.action.request_id);
      if (loss === "cancel") f.db.db.prepare("UPDATE control_command_requests SET state='cancelled' WHERE request_id=?").run(f.action.request_id);
      if (loss === "revocation") f.db.db.prepare("INSERT INTO authority_revocations VALUES(?,?,?)")
        .run(f.action.request_id,"fixture revoke",NOW.toISOString());
      if (loss === "proof_signature") f.db.db.prepare("UPDATE memory_correction_proofs SET proof_json=json_set(proof_json,'$.signature',?)")
        .run("a".repeat(86));
      if (loss === "purge_digest") f.db.db.prepare("UPDATE memory_correction_proofs SET purge_receipt_digest=?")
        .run(`sha256:${"0".repeat(64)}`);
      if (loss === "missing_binding") {
        f.db.db.exec("DROP TRIGGER memory_correction_control_binding_delete");
        f.db.db.prepare("DELETE FROM memory_correction_control_bindings").run();
      }
      if (loss === "cancel" || loss === "revocation") expect(reconcileCorrectionControl(f.db,f.record.correction_id,LATER)).toBe(false);
      else expect(() => reconcileCorrectionControl(f.db,f.record.correction_id,LATER)).toThrow("MEMORY_CORRECTION_CONTROL_EVIDENCE_INVALID");
      expect(state(f)).not.toEqual({ state: "completed" }); expect(f.writer.calls).toHaveLength(1);
    } finally { await f.close(); }
  });
});
