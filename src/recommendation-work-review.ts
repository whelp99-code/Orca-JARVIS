import { canonicalize } from "./canonical.js";
import { RecommendationWorkProgressRuntime } from "./recommendation-work-progress.js";
import { persistenceHash } from "./personal-persistence-values.js";
import { verifyRecommendationReceipt } from "./recommendation-work-verification.js";
import { workFail, workRow, workText } from "./recommendation-work-dispatch.js";
import type { RecommendationVerificationReceipt, WorkLease } from "./recommendation-work-types.js";

export class RecommendationWorkReviewRuntime extends RecommendationWorkProgressRuntime {
  recordVerification(runtimeId: string, lease: WorkLease, value: RecommendationVerificationReceipt): string {
    const prior = this.authority.db.prepare(`SELECT * FROM recommendation_work_verification_receipts
      WHERE verification_request_id=?`).get(value.verification_request_id);
    if (prior !== undefined) {
      const stored = workRow(prior);
      if (stored["receipt_json"] !== canonicalize(value)) {
        return workFail("RECOMMENDATION_VERIFICATION_REPLAY_CONFLICT");
      }
      return workText(stored["receipt_id"]);
    }
    const current = this.leased(runtimeId, lease); const identity = this.identity(current);
    const nowText = this.clock().toISOString();
    const verifier = workRow(this.authority.db.prepare(`SELECT k.public_key_pem,k.principal_id,b.session_id,
      b.incarnation_id FROM trusted_authority_keys k
      JOIN authority_key_purposes p ON p.key_id=k.key_id AND p.purpose='verifier'
      JOIN recommendation_work_verifier_bindings b ON b.key_id=k.key_id AND b.principal_id=k.principal_id
      LEFT JOIN authority_revocations r ON r.reference IN (k.key_id,k.principal_id,b.binding_id)
      WHERE k.key_id=? AND b.not_before<=? AND b.expires_at>? AND r.reference IS NULL`)
      .get(value.key_id, nowText, nowText), "RECOMMENDATION_VERIFICATION_INVALID");
    const receipt = verifyRecommendationReceipt(value, workText(verifier["public_key_pem"]), this.clock());
    const request = workRow(this.authority.db.prepare(`SELECT * FROM recommendation_work_verification_requests
      WHERE verification_request_id=? AND runtime_id=?`).get(receipt.verification_request_id, runtimeId),
    "RECOMMENDATION_VERIFICATION_INVALID");
    const expected = workRow(JSON.parse(workText(request["request_json"])));
    const dispatch = workRow(this.authority.db.prepare(`SELECT receipt_json FROM recommendation_work_dispatch_receipts
      WHERE receipt_id=?`).get(request["dispatch_receipt_id"]));
    const dispatchReceipt = workRow(JSON.parse(workText(dispatch["receipt_json"])));
    if (receipt.runtime_id !== runtimeId || receipt.run_id !== identity.run_id
      || receipt.workflow_digest !== identity.workflow_digest || receipt.request_digest !== request["request_digest"]
      || receipt.dispatch_receipt_id !== request["dispatch_receipt_id"]
      || receipt.incarnation_id !== expected["incarnation_id"] || receipt.commit_digest !== request["commit_digest"]
      || receipt.artifact_digest !== request["artifact_digest"] || receipt.test_digest !== request["test_digest"]
      || receipt.evidence_digest !== request["evidence_digest"]
      || receipt.verifier_principal_id !== verifier["principal_id"]
      || receipt.verifier_session_id !== verifier["session_id"]
      || receipt.verifier_incarnation_id !== verifier["incarnation_id"]
      || receipt.verifier_principal_id === identity.implementer_principal_id
      || receipt.verifier_principal_id === identity.correlation["requested_by_principal_id"]
      || receipt.verifier_session_id === dispatchReceipt["session_id"]
      || receipt.verifier_incarnation_id === dispatchReceipt["incarnation_id"]
      || receipt.key_id === dispatchReceipt["key_id"] || receipt.key_id === expected["progress_key_id"]
      || current["state"] !== "progressed") {
      return workFail("RECOMMENDATION_VERIFICATION_BINDING_INVALID");
    }
    this.authority.db.transaction(() => {
      this.leased(runtimeId, lease); const receiptJson = canonicalize(receipt); const now = this.clock().toISOString();
      this.authority.db.prepare(`INSERT INTO recommendation_work_verification_receipts(receipt_id,runtime_id,
        verification_request_id,receipt_json,receipt_digest,decision,artifact_digest,test_digest,evidence_digest,
        commit_digest,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(receipt.receipt_id, runtimeId,
        receipt.verification_request_id, receiptJson, persistenceHash(receipt), receipt.decision,
        receipt.artifact_digest, receipt.test_digest, receipt.evidence_digest, receipt.commit_digest, now);
      if (receipt.decision === "REJECT") this.negative(runtimeId, "verifier_reject", receipt.evidence_digest);
      const changed = this.authority.db.prepare(`UPDATE recommendation_work_runtimes SET state=?,
        recovery_attempts=recovery_attempts+?,failure_code=?,updated_at=? WHERE runtime_id=? AND lease_fence=?
        AND state='progressed'`).run(receipt.decision === "PASS" ? "verified" : "recovering",
        receipt.decision === "PASS" ? 0 : 1, receipt.decision === "PASS" ? null : "VERIFIER_REJECT",
        now, runtimeId, lease.fence);
      if (changed.changes !== 1) return workFail("RECOMMENDATION_WORK_TERMINAL_RACE");
    })();
    this.checkpoint("verification_committed");
    return receipt.receipt_id;
  }
}
