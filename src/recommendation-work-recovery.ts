import { canonicalize } from "./canonical.js";
import { JarvisError } from "./db.js";
import { persistenceHash } from "./personal-persistence-values.js";
import { parseDispatchReceipt, RecommendationWorkDispatchRuntime } from "./recommendation-work-dispatch.js";
import type { DispatchReceipt, WorkLease } from "./recommendation-work-types.js";

type Row = Readonly<Record<string, unknown>>;
function fail(code: string): never { throw new JarvisError(code); }
function row(value: unknown): Row {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Row
    : fail("RECOMMENDATION_WORK_NOT_FOUND");
}
export class RecommendationWorkRecoveryRuntime extends RecommendationWorkDispatchRuntime {
  reconcile(runtimeId: string, lease: WorkLease, value: DispatchReceipt): DispatchReceipt {
    const current = this.leased(runtimeId, lease);
    const prior = this.authority.db.prepare("SELECT receipt_json FROM recommendation_work_dispatch_receipts WHERE runtime_id=?")
      .get(runtimeId);
    if (prior !== undefined) return JSON.parse(String(row(prior)["receipt_json"]));
    if (current["state"] !== "blocked" || current["failure_code"] !== "DISPATCH_UNCERTAIN") {
      return fail("RECOMMENDATION_RECONCILIATION_NOT_ALLOWED");
    }
    const attempt = row(this.authority.db.prepare(`SELECT * FROM recommendation_work_dispatch_attempts
      WHERE runtime_id=? AND state='uncertain' ORDER BY attempt DESC LIMIT 1`).get(runtimeId));
    const receipt = parseDispatchReceipt(value, this.intent(current)); const receiptJson = canonicalize(receipt);
    this.authority.db.transaction(() => {
      this.leased(runtimeId, lease);
      this.authority.db.prepare(`UPDATE recommendation_work_dispatch_attempts
        SET state='accepted',updated_at=? WHERE attempt_id=? AND lease_fence=? AND state='uncertain'`)
        .run(this.clock().toISOString(), attempt["attempt_id"], lease.fence);
      this.authority.db.prepare(`INSERT INTO recommendation_work_dispatch_receipts
        (receipt_id,runtime_id,attempt_id,receipt_json,receipt_digest,accepted_at) VALUES(?,?,?,?,?,?)`)
        .run(receipt.receipt_id, runtimeId, attempt["attempt_id"], receiptJson, persistenceHash(receipt), receipt.accepted_at);
      const changed = this.authority.db.prepare(`UPDATE recommendation_work_runtimes SET state='dispatched',
        current_incarnation_id=?,failure_code=NULL,updated_at=? WHERE runtime_id=? AND lease_fence=? AND state='blocked'`)
        .run(receipt.incarnation_id, this.clock().toISOString(), runtimeId, lease.fence);
      if (changed.changes !== 1) return fail("RECOMMENDATION_WORK_TERMINAL_RACE");
    })();
    return receipt;
  }
  failRecovery(runtimeId: string, lease: WorkLease, reason: string): Readonly<Record<string, unknown>> {
    const current = this.leased(runtimeId, lease); const identity = this.identity(current);
    const budget = row(identity.correlation["budget"]); const attempts = Number(current["recovery_attempts"]) + 1;
    const exhausted = attempts >= Number(budget["max_attempts_per_node"])
      || Date.parse(String(budget["deadline"])) <= this.clock().getTime();
    this.negative(runtimeId, reason, { recovery_attempt: attempts });
    const changed = this.authority.db.prepare(`UPDATE recommendation_work_runtimes
      SET state=?,recovery_attempts=?,failure_code=?,updated_at=? WHERE runtime_id=? AND lease_fence=?`)
      .run(exhausted ? "failed" : "recovering", attempts, reason, this.clock().toISOString(), runtimeId, lease.fence);
    if (changed.changes !== 1) return fail("RECOMMENDATION_WORK_STALE_FENCE");
    return { runtime_id: runtimeId, state: exhausted ? "failed" : "recovering", attempts };
  }
}
