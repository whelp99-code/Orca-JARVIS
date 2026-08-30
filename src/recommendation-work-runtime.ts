import { canonicalize } from "./canonical.js";
import { RecommendationWorkReviewRuntime } from "./recommendation-work-review.js";
import { persistenceHash } from "./personal-persistence-values.js";
import { workFail, workRow, workText, type WorkRow } from "./recommendation-work-dispatch.js";
import type { RecommendationWorkSettlement, WorkLease } from "./recommendation-work-types.js";

function settlement(value: WorkRow): RecommendationWorkSettlement {
  const payload = workRow(JSON.parse(workText(value["settlement_json"]))); const candidate = payload["candidate"];
  return { settlement_id: workText(value["settlement_id"]), runtime_id: workText(value["runtime_id"]),
    state: value["outcome"] === "completed" ? "completed" : value["outcome"] === "cancelled" ? "cancelled" : "failed",
    candidate: candidate === null ? null : workRow(candidate) };
}
export class RecommendationWorkRuntime extends RecommendationWorkReviewRuntime {
  settle(runtimeId: string, lease: WorkLease): RecommendationWorkSettlement {
    const prior = this.authority.db.prepare("SELECT * FROM recommendation_work_settlements WHERE runtime_id=?")
      .get(runtimeId);
    if (prior !== undefined) return settlement(workRow(prior));
    const current = this.leased(runtimeId, lease);
    if (current["state"] !== "verified") return workFail("RECOMMENDATION_WORK_NOT_VERIFIED");
    const identity = this.identity(current);
    const verification = workRow(this.authority.db.prepare(`SELECT * FROM recommendation_work_verification_receipts
      WHERE runtime_id=? AND decision='PASS'`).get(runtimeId), "RECOMMENDATION_WORK_NOT_VERIFIED");
    const request = workRow(this.authority.db.prepare(`SELECT * FROM recommendation_work_verification_requests
      WHERE verification_request_id=?`).get(verification["verification_request_id"]));
    const dispatch = workRow(this.authority.db.prepare(`SELECT receipt_json,receipt_digest
      FROM recommendation_work_dispatch_receipts WHERE receipt_id=?`).get(request["dispatch_receipt_id"]));
    const dispatchReceipt = workRow(JSON.parse(workText(dispatch["receipt_json"])));
    const progress = workRow(this.authority.db.prepare(`SELECT event_id,signal_digest FROM recommendation_work_progress
      WHERE runtime_id=? AND dispatch_receipt_id=? ORDER BY sequence DESC LIMIT 1`)
      .get(runtimeId, request["dispatch_receipt_id"]));
    const candidate = { schema_version: 1, kind: "verified_outcome", runtime_id: runtimeId,
      recommendation_id: identity.correlation["recommendation_id"], action_rank: identity.correlation["action_rank"],
      run_id: identity.run_id, workflow_digest: identity.workflow_digest, request_digest: request["request_digest"],
      correlation_digest: persistenceHash(identity.correlation), commit_digest: request["commit_digest"],
      artifact_digest: request["artifact_digest"], test_digest: request["test_digest"],
      verifier_evidence_digest: request["evidence_digest"], verifier_receipt_id: verification["receipt_id"],
      source_refs: [identity.request_id, identity.receipt_id, dispatchReceipt["receipt_id"], progress["event_id"]],
      dispatch_digest: dispatch["receipt_digest"], progress_digest: progress["signal_digest"] };
    const settlementId = `settlement:${persistenceHash({ runtime_id: runtimeId, outcome: "completed" }).slice(7)}`;
    const result: RecommendationWorkSettlement = { settlement_id: settlementId, runtime_id: runtimeId,
      state: "completed", candidate };
    this.authority.db.transaction(() => {
      this.leased(runtimeId, lease); const now = this.clock().toISOString();
      const changed = this.authority.db.prepare(`UPDATE recommendation_work_runtimes SET state='completed',
        failure_code=NULL,updated_at=? WHERE runtime_id=? AND lease_fence=? AND state='verified'`)
        .run(now, runtimeId, lease.fence);
      if (changed.changes !== 1) return workFail("RECOMMENDATION_WORK_TERMINAL_RACE");
      this.authority.db.prepare(`INSERT INTO recommendation_work_settlements
        (settlement_id,runtime_id,outcome,settlement_json,settlement_digest,created_at) VALUES(?,?,?,?,?,?)`)
        .run(settlementId, runtimeId, "completed", canonicalize(result), persistenceHash(result), now);
      const candidateDigest = persistenceHash(candidate);
      this.authority.db.prepare(`INSERT INTO recommendation_verified_outcomes
        (candidate_id,runtime_id,payload_json,payload_digest,created_at) VALUES(?,?,?,?,?)`)
        .run(`verified-outcome:${candidateDigest.slice(7)}`, runtimeId, canonicalize(candidate), candidateDigest, now);
      this.authority.db.prepare(`UPDATE workflow_runs SET state='completed',current_node='complete',completed_at=?,
        updated_at=? WHERE run_id=? AND state NOT IN ('completed','failed','cancelled')`).run(now, now, identity.run_id);
    })();
    this.checkpoint("settlement_committed");
    return result;
  }
  cancel(runtimeId: string, lease: WorkLease, reason: string): RecommendationWorkSettlement {
    const prior = this.authority.db.prepare("SELECT * FROM recommendation_work_settlements WHERE runtime_id=?")
      .get(runtimeId);
    if (prior !== undefined) return settlement(workRow(prior));
    const current = this.leased(runtimeId, lease); const identity = this.identity(current);
    const settlementId = `settlement:${persistenceHash({ runtime_id: runtimeId, outcome: "cancelled", reason }).slice(7)}`;
    const result: RecommendationWorkSettlement = { settlement_id: settlementId, runtime_id: runtimeId,
      state: "cancelled", candidate: null };
    this.authority.db.transaction(() => {
      this.leased(runtimeId, lease); const now = this.clock().toISOString();
      const changed = this.authority.db.prepare(`UPDATE recommendation_work_runtimes SET state='cancelled',
        failure_code=?,updated_at=? WHERE runtime_id=? AND lease_fence=?
        AND state NOT IN ('dispatching','completed','failed','cancelled')`).run(reason, now, runtimeId, lease.fence);
      if (changed.changes !== 1) return workFail("RECOMMENDATION_WORK_TERMINAL_RACE");
      this.authority.db.prepare(`INSERT INTO recommendation_work_settlements
        (settlement_id,runtime_id,outcome,settlement_json,settlement_digest,created_at) VALUES(?,?,?,?,?,?)`)
        .run(settlementId, runtimeId, "cancelled", canonicalize(result), persistenceHash(result), now);
      this.authority.db.prepare(`UPDATE workflow_runs SET state='cancelled',completed_at=?,updated_at=?,failure_code=?
        WHERE run_id=? AND state NOT IN ('completed','failed','cancelled')`).run(now, now, reason, identity.run_id);
    })();
    return result;
  }
  status(runtimeId: string): Readonly<Record<string, unknown>> {
    const current = workRow(this.authority.db.prepare(
      "SELECT * FROM recommendation_work_runtimes WHERE runtime_id=?",
    ).get(runtimeId));
    const settled = this.authority.db.prepare(
      "SELECT settlement_json FROM recommendation_work_settlements WHERE runtime_id=?",
    ).get(runtimeId);
    return { runtime_id: runtimeId, state: current["state"], failure_code: current["failure_code"],
      dispatch_attempts: current["dispatch_attempts"], recovery_attempts: current["recovery_attempts"],
      progress_sequence: current["progress_sequence"], next_operator_action: current["state"] === "blocked"
        ? "reconcile_exact_receipt" : null, settlement: settled === undefined ? null
          : JSON.parse(workText(workRow(settled)["settlement_json"])) };
  }
}
