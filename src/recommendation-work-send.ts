import { canonicalize } from "./canonical.js";
import { parseDispatchOutcome, parseDispatchReceipt } from "./recommendation-work-crypto.js";
import {
  RecommendationWorkDispatchRuntime, workFail, workRow, workText,
} from "./recommendation-work-dispatch.js";
import { persistenceHash } from "./personal-persistence-values.js";
import { closedRecord } from "./task25-closed-input.js";
import type { DispatchAdapter, DispatchReceipt, WorkLease } from "./recommendation-work-types.js";

export class RecommendationWorkSendRuntime extends RecommendationWorkDispatchRuntime {
  async dispatch(runtimeId: string, lease: WorkLease, adapter: DispatchAdapter): Promise<{
    readonly state: string; readonly receipt: DispatchReceipt | null; readonly verification_request_id: string;
  }> {
    const current = this.leased(runtimeId, lease); const identity = this.identity(current);
    const existing = this.authority.db.prepare(`SELECT receipt_json FROM recommendation_work_dispatch_receipts
      WHERE receipt_id=(SELECT current_dispatch_receipt_id FROM recommendation_work_runtimes WHERE runtime_id=?)`)
      .get(runtimeId);
    if (existing !== undefined) return { state: "dispatched",
      receipt: JSON.parse(workText(workRow(existing)["receipt_json"])),
      verification_request_id: identity.verification_request_id };
    if (current["state"] === "dispatching") {
      this.authority.db.prepare(`UPDATE recommendation_work_runtimes SET state='blocked',
        failure_code='DISPATCH_UNCERTAIN',updated_at=? WHERE runtime_id=? AND lease_fence=? AND state='dispatching'`)
        .run(this.clock().toISOString(), runtimeId, lease.fence);
      this.negative(runtimeId, "crash_after_observable_send", { fence: lease.fence });
      return workFail("RECOMMENDATION_DISPATCH_UNCERTAIN");
    }
    if (current["state"] === "blocked") return workFail("RECOMMENDATION_DISPATCH_UNCERTAIN");
    const budget = workRow(identity.correlation["budget"]); const attempt = Number(current["dispatch_attempts"]) + 1;
    if (attempt > Number(budget["max_attempts_per_node"])
      || Date.parse(workText(budget["deadline"])) <= this.clock().getTime()) {
      this.negative(runtimeId, "dispatch_budget_exhausted", { attempt });
      this.authority.db.prepare(`UPDATE recommendation_work_runtimes SET state='failed',failure_code=?,updated_at=?
        WHERE runtime_id=? AND lease_fence=?`).run("DISPATCH_BUDGET_EXHAUSTED", this.clock().toISOString(),
        runtimeId, lease.fence);
      return workFail("RECOMMENDATION_DISPATCH_BUDGET_EXHAUSTED");
    }
    const attemptId = `dispatch-attempt:${persistenceHash({ runtime_id: runtimeId, attempt }).slice(7)}`;
    this.authority.db.transaction(() => {
      this.leased(runtimeId, lease);
      this.authority.db.prepare(`INSERT INTO recommendation_work_dispatch_attempts
        (attempt_id,runtime_id,lease_fence,attempt,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?)`)
        .run(attemptId, runtimeId, lease.fence, attempt, "prepared", this.clock().toISOString(), this.clock().toISOString());
      this.authority.db.prepare(`UPDATE recommendation_work_runtimes SET dispatch_attempts=?,updated_at=?
        WHERE runtime_id=? AND lease_fence=?`).run(attempt, this.clock().toISOString(), runtimeId, lease.fence);
    })();
    this.checkpoint("attempt_committed");
    const intent = this.intent(current, attemptId); let eventId: string;
    try { eventId = workText((await adapter.subscribe(intent)).event_id); }
    catch (error) {
      const cancelled = this.dispatchFailure(runtimeId, lease, attemptId, "not_sent", "subscription_failed",
        error instanceof Error ? error.name : typeof error);
      return { state: cancelled ? "cancelled" : "prepared", receipt: null,
        verification_request_id: identity.verification_request_id };
    }
    const invoking = this.authority.db.prepare(`UPDATE recommendation_work_runtimes
      SET state='dispatching',updated_at=? WHERE runtime_id=? AND lease_fence=? AND state='prepared'`)
      .run(this.clock().toISOString(), runtimeId, lease.fence);
    if (invoking.changes !== 1) {
      const terminal = this.authority.db.prepare(`SELECT outcome FROM recommendation_work_settlements
        WHERE runtime_id=?`).get(runtimeId) as { outcome: string } | undefined;
      if (terminal?.outcome === "cancelled") return { state: "cancelled", receipt: null,
        verification_request_id: identity.verification_request_id };
      return workFail("RECOMMENDATION_WORK_TERMINAL_RACE");
    }
    let raw: unknown;
    try { raw = await adapter.trigger(intent); }
    catch (error) {
      const cancelled = this.dispatchFailure(runtimeId, lease, attemptId, "uncertain", "trigger_threw",
        error instanceof Error ? error.name : typeof error, eventId);
      return { state: cancelled ? "cancelled" : "blocked", receipt: null,
        verification_request_id: identity.verification_request_id };
    }
    let outcome: ReturnType<typeof parseDispatchOutcome>;
    try { outcome = parseDispatchOutcome(raw); }
    catch (error) {
      const cancelled = this.dispatchFailure(runtimeId, lease, attemptId, "uncertain", "invalid_outcome",
        error instanceof Error ? error.name : typeof error, eventId);
      return { state: cancelled ? "cancelled" : "blocked", receipt: null,
        verification_request_id: identity.verification_request_id };
    }
    switch (outcome.kind) {
      case "not_sent": {
        const cancelled = this.dispatchFailure(runtimeId, lease, attemptId, "not_sent", outcome.reason, outcome, eventId);
        return { state: cancelled ? "cancelled" : "prepared", receipt: null,
          verification_request_id: identity.verification_request_id };
      }
      case "uncertain": {
        const cancelled = this.dispatchFailure(runtimeId, lease, attemptId, "uncertain", outcome.reason, outcome, eventId);
        return { state: cancelled ? "cancelled" : "blocked", receipt: null,
          verification_request_id: identity.verification_request_id };
      }
      case "accepted": {
        const header = closedRecord(outcome.receipt); const provider = header["provider"];
        if (provider !== "codex" && provider !== "claude") return workFail("RECOMMENDATION_DISPATCH_RECEIPT_INVALID");
        const keyId = workText(header["key_id"]); let receipt: DispatchReceipt;
        try {
          receipt = parseDispatchReceipt(outcome.receipt, {
            intent, publicKey: this.providerKey(keyId, provider, "authority-receipt"), now: this.clock(),
          });
        } catch (error) {
          const cancelled = this.dispatchFailure(runtimeId, lease, attemptId, "uncertain", "invalid_receipt",
            error instanceof Error ? error.name : typeof error, eventId);
          return { state: cancelled ? "cancelled" : "blocked", receipt: null,
            verification_request_id: identity.verification_request_id };
        }
        const state = this.accept(runtimeId, lease, receipt, eventId); return { state, receipt,
          verification_request_id: identity.verification_request_id };
      }
      default: {
        const exhaustive: never = outcome; return exhaustive;
      }
    }
  }
  protected accept(runtimeId: string, lease: WorkLease, receipt: DispatchReceipt, eventId: string): "dispatched" | "cancelled" {
    let finalState: "dispatched" | "cancelled" = "dispatched";
    this.authority.db.transaction(() => {
      this.leased(runtimeId, lease); const receiptJson = canonicalize(receipt);
      this.authority.db.prepare(`UPDATE recommendation_work_dispatch_attempts SET state='accepted',event_id=?,
        updated_at=? WHERE attempt_id=? AND lease_fence=?`).run(eventId, this.clock().toISOString(),
        receipt.attempt_id, lease.fence);
      this.authority.db.prepare(`INSERT INTO recommendation_work_dispatch_receipts(receipt_id,runtime_id,attempt_id,
        incarnation_id,receipt_json,receipt_digest,accepted_at) VALUES(?,?,?,?,?,?,?)`).run(receipt.receipt_id,
        runtimeId, receipt.attempt_id, receipt.incarnation_id, receiptJson, persistenceHash(receipt), receipt.accepted_at);
      const pending = this.pendingCancellation(runtimeId); const now = this.clock().toISOString();
      const changed = this.authority.db.prepare(`UPDATE recommendation_work_runtimes SET state=?,
        current_incarnation_id=?,current_dispatch_receipt_id=?,updated_at=? WHERE runtime_id=? AND lease_fence=?`)
        .run(pending === undefined ? "dispatched" : "dispatching", receipt.incarnation_id,
          receipt.receipt_id, now, runtimeId, lease.fence);
      if (changed.changes !== 1) return workFail("RECOMMENDATION_WORK_STALE_FENCE");
      if (pending !== undefined) {
        if (!this.resolvePendingCancellation(runtimeId, lease)) return workFail("RECOMMENDATION_WORK_TERMINAL_RACE");
        finalState = "cancelled";
      }
    })();
    this.checkpoint("dispatch_committed"); return finalState;
  }
  private dispatchFailure(runtimeId: string, lease: WorkLease, attemptId: string,
    state: "not_sent" | "uncertain", reason: string, material: unknown, eventId?: string): boolean {
    let cancelled = false;
    this.authority.db.transaction(() => {
      this.leased(runtimeId, lease); const evidence = persistenceHash({ runtime_id: runtimeId, reason, material });
      this.authority.db.prepare(`UPDATE recommendation_work_dispatch_attempts
        SET state=?,event_id=?,evidence_digest=?,updated_at=? WHERE attempt_id=? AND lease_fence=?`)
        .run(state, eventId ?? null, evidence, this.clock().toISOString(), attemptId, lease.fence);
      this.negative(runtimeId, reason, material);
      if (this.pendingCancellation(runtimeId) !== undefined) {
        cancelled = this.resolvePendingCancellation(runtimeId, lease);
      } else {
        this.authority.db.prepare(`UPDATE recommendation_work_runtimes SET state=?,failure_code=?,updated_at=?
          WHERE runtime_id=? AND lease_fence=?`).run(state === "uncertain" ? "blocked" : "prepared",
          state === "uncertain" ? "DISPATCH_UNCERTAIN" : null, this.clock().toISOString(), runtimeId, lease.fence);
      }
    })();
    return cancelled;
  }
}
