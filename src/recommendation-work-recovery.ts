import { canonicalize } from "./canonical.js";
import { closedRecord } from "./task25-closed-input.js";
import { parseDispatchReceipt } from "./recommendation-work-crypto.js";
import { RecommendationWorkSendRuntime } from "./recommendation-work-send.js";
import { persistenceHash } from "./personal-persistence-values.js";
import { workFail, workRow, workText } from "./recommendation-work-dispatch.js";
import type { DispatchReceipt, WorkLease } from "./recommendation-work-types.js";

export class RecommendationWorkRecoveryRuntime extends RecommendationWorkSendRuntime {
  reconcile(runtimeId: string, lease: WorkLease, value: DispatchReceipt): DispatchReceipt {
    const current = this.leased(runtimeId, lease);
    const prior = this.authority.db.prepare(`SELECT receipt_json FROM recommendation_work_dispatch_receipts
      WHERE receipt_id=(SELECT current_dispatch_receipt_id FROM recommendation_work_runtimes WHERE runtime_id=?)`)
      .get(runtimeId);
    if (prior !== undefined) return JSON.parse(workText(workRow(prior)["receipt_json"]));
    if (current["state"] !== "blocked" || current["failure_code"] !== "DISPATCH_UNCERTAIN") {
      return workFail("RECOMMENDATION_RECONCILIATION_NOT_ALLOWED");
    }
    const attempt = workRow(this.authority.db.prepare(`SELECT * FROM recommendation_work_dispatch_attempts
      WHERE runtime_id=? AND state='uncertain' ORDER BY attempt DESC LIMIT 1`).get(runtimeId));
    const header = closedRecord(value); const provider = header["provider"];
    if (provider !== "codex" && provider !== "claude") return workFail("RECOMMENDATION_DISPATCH_RECEIPT_INVALID");
    const receipt = parseDispatchReceipt(value, { intent: this.intent(current, workText(attempt["attempt_id"])),
      publicKey: this.providerKey(workText(header["key_id"]), provider, "authority-receipt"), now: this.clock() });
    this.accept(runtimeId, lease, receipt, workText(attempt["event_id"])); return receipt;
  }
  replaceIncarnation(runtimeId: string, lease: WorkLease, value: DispatchReceipt): DispatchReceipt {
    const current = this.leased(runtimeId, lease);
    if (current["state"] !== "recovering") return workFail("RECOMMENDATION_RECOVERY_NOT_ALLOWED");
    const recovery = Number(current["recovery_attempts"]) + 1; const attempt = Number(current["dispatch_attempts"]) + 1;
    const budget = workRow(this.identity(current).correlation["budget"]);
    if (recovery > Number(budget["max_attempts_per_node"])) return workFail("RECOMMENDATION_RECOVERY_EXHAUSTED");
    const attemptId = `recovery-attempt:${persistenceHash({ runtime_id: runtimeId, recovery }).slice(7)}`;
    const header = closedRecord(value); const provider = header["provider"];
    if (provider !== "codex" && provider !== "claude") return workFail("RECOMMENDATION_DISPATCH_RECEIPT_INVALID");
    const receipt = parseDispatchReceipt(value, { intent: this.intent(current, attemptId),
      publicKey: this.providerKey(workText(header["key_id"]), provider, "authority-receipt"), now: this.clock() });
    if (receipt.incarnation_id === current["current_incarnation_id"]) {
      return workFail("RECOMMENDATION_RECOVERY_INCARNATION_CONFLICT");
    }
    this.authority.db.transaction(() => {
      this.leased(runtimeId, lease);
      this.authority.db.prepare(`INSERT INTO recommendation_work_dispatch_attempts
        (attempt_id,runtime_id,lease_fence,attempt,state,event_id,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?)`).run(attemptId, runtimeId, lease.fence, attempt, "prepared", null,
        this.clock().toISOString(), this.clock().toISOString());
      this.authority.db.prepare(`UPDATE recommendation_work_runtimes SET dispatch_attempts=?,recovery_attempts=?,
        state='prepared',failure_code=NULL,progress_sequence=0,updated_at=? WHERE runtime_id=? AND lease_fence=?`)
        .run(attempt, recovery, this.clock().toISOString(), runtimeId, lease.fence);
    })();
    this.accept(runtimeId, lease, receipt, `recovery:${recovery}`); return receipt;
  }
  failRecovery(runtimeId: string, lease: WorkLease, reason: string): Readonly<Record<string, unknown>> {
    const current = this.leased(runtimeId, lease); const identity = this.identity(current);
    const budget = workRow(identity.correlation["budget"]); const attempts = Number(current["recovery_attempts"]) + 1;
    const exhausted = attempts >= Number(budget["max_attempts_per_node"])
      || Date.parse(workText(budget["deadline"])) <= this.clock().getTime();
    const result = { runtime_id: runtimeId, state: exhausted ? "failed" : "recovering", attempts };
    this.authority.db.transaction(() => {
      this.leased(runtimeId, lease); this.negative(runtimeId, reason, { recovery_attempt: attempts });
      const now = this.clock().toISOString();
      const changed = this.authority.db.prepare(`UPDATE recommendation_work_runtimes SET state=?,recovery_attempts=?,
        failure_code=?,updated_at=? WHERE runtime_id=? AND lease_fence=?`).run(result.state, attempts, reason, now,
        runtimeId, lease.fence);
      if (changed.changes !== 1) return workFail("RECOMMENDATION_WORK_STALE_FENCE");
      if (exhausted) {
        const settlement = { settlement_id:
          `settlement:${persistenceHash({ runtime_id: runtimeId, outcome: "failed", reason }).slice(7)}`,
          runtime_id: runtimeId, state: "failed", candidate: null };
        this.authority.db.prepare(`INSERT OR IGNORE INTO recommendation_work_settlements
          (settlement_id,runtime_id,outcome,settlement_json,settlement_digest,created_at) VALUES(?,?,?,?,?,?)`)
          .run(settlement.settlement_id, runtimeId, "failed", canonicalize(settlement), persistenceHash(settlement), now);
        this.authority.db.prepare(`UPDATE workflow_runs SET state='failed',current_node='fail',completed_at=?,updated_at=?,
          failure_code=? WHERE run_id=? AND state NOT IN ('completed','failed','cancelled')`)
          .run(now, now, reason, identity.run_id);
      }
    })();
    return result;
  }
}
