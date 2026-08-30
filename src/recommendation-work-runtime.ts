import { canonicalize } from "./canonical.js";
import { JarvisError } from "./db.js";
import { persistenceHash } from "./personal-persistence-values.js";
import { parseProgressSignal, verifyProgressSignal } from "./progress-signal.js";
import { RecommendationWorkRecoveryRuntime } from "./recommendation-work-recovery.js";
import type {
  DispatchReceipt, ProgressInput, RecommendationVerificationReceipt, RecommendationWorkSettlement, WorkLease,
} from "./recommendation-work-types.js";
import { verifyRecommendationReceipt } from "./recommendation-work-verification.js";

type Row = Readonly<Record<string, unknown>>;
function fail(code: string): never { throw new JarvisError(code); }
function row(value: unknown, code = "RECOMMENDATION_WORK_NOT_FOUND"): Row {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Row : fail(code);
}
function text(value: unknown): string { return typeof value === "string" && value.length > 0
  ? value : fail("RECOMMENDATION_WORK_STATE_INVALID"); }
function settlement(value: Row): RecommendationWorkSettlement {
  const payload = row(JSON.parse(text(value["settlement_json"])));
  const candidate = payload["candidate"];
  return { settlement_id: text(value["settlement_id"]), runtime_id: text(value["runtime_id"]),
    state: value["outcome"] === "completed" ? "completed" : value["outcome"] === "cancelled" ? "cancelled" : "failed",
    candidate: candidate === null ? null : row(candidate) };
}
export class RecommendationWorkRuntime extends RecommendationWorkRecoveryRuntime {
  recordNonterminal(runtimeId: string, lease: WorkLease,
    event: { readonly event_id: string; readonly kind: "worker_done" | "idle" | "prompt" | "self_review" }): string {
    const prior = this.authority.db.prepare("SELECT * FROM recommendation_work_nonterminal_events WHERE event_id=?")
      .get(event.event_id);
    if (prior !== undefined) {
      const stored = row(prior); if (stored["runtime_id"] !== runtimeId || stored["kind"] !== event.kind) {
        return fail("RECOMMENDATION_WORK_EVENT_CONFLICT");
      }
      return String(stored["kind"]);
    }
    this.leased(runtimeId, lease);
    this.authority.db.prepare(`INSERT INTO recommendation_work_nonterminal_events
      (event_id,runtime_id,kind,created_at) VALUES(?,?,?,?)`)
      .run(event.event_id, runtimeId, event.kind, this.clock().toISOString());
    return event.kind;
  }
  recordProgress(runtimeId: string, lease: WorkLease, value: ProgressInput): string {
    const signal = parseProgressSignal(value);
    const existing = this.authority.db.prepare("SELECT * FROM recommendation_work_progress WHERE event_id=?")
      .get(signal.event_id);
    if (existing !== undefined) {
      const stored = row(existing); if (stored["runtime_id"] !== runtimeId
        || stored["signal_json"] !== canonicalize(signal)) return fail("RECOMMENDATION_PROGRESS_REPLAY_CONFLICT");
      return signal.event_id;
    }
    const current = this.leased(runtimeId, lease);
    const dispatchRow = row(this.authority.db.prepare(`SELECT receipt_id,receipt_json
      FROM recommendation_work_dispatch_receipts WHERE runtime_id=?`).get(runtimeId), "RECOMMENDATION_DISPATCH_REQUIRED");
    const dispatch = row(JSON.parse(text(dispatchRow["receipt_json"]))) as DispatchReceipt;
    const key = row(this.authority.db.prepare("SELECT * FROM recommendation_work_progress_keys WHERE key_id=?")
      .get(signal.key_id), "RECOMMENDATION_PROGRESS_KEY_INVALID");
    const now = this.clock(); const observed = Date.parse(signal.observed_at);
    const sequence = Number(signal.sequence); const expected = Number(current["progress_sequence"]) + 1;
    if (signal.provider !== dispatch.provider || signal.terminal_id !== dispatch.terminal_id
      || signal.incarnation_id !== dispatch.incarnation_id || signal.cursor !== signal.sequence
      || sequence !== expected || observed > now.getTime() || now.getTime() - observed > 15 * 60_000
      || !verifyProgressSignal(signal, { key_id: text(key["key_id"]), purpose: "progress-signal",
        provider: dispatch.provider, public_key_pem: text(key["public_key_pem"]), active: true,
        not_before: text(key["not_before"]), expires_at: text(key["expires_at"]) }, now)) {
      return fail("RECOMMENDATION_PROGRESS_INVALID");
    }
    this.authority.db.transaction(() => {
      this.leased(runtimeId, lease); const signalJson = canonicalize(signal);
      this.authority.db.prepare(`INSERT INTO recommendation_work_progress(event_id,runtime_id,dispatch_receipt_id,
        sequence,signal_json,signal_digest,observed_at) VALUES(?,?,?,?,?,?,?)`)
        .run(signal.event_id, runtimeId, dispatchRow["receipt_id"], sequence, signalJson,
          persistenceHash(signal), signal.observed_at);
      const changed = this.authority.db.prepare(`UPDATE recommendation_work_runtimes
        SET state='progressed',progress_sequence=?,updated_at=? WHERE runtime_id=? AND lease_fence=?`)
        .run(sequence, now.toISOString(), runtimeId, lease.fence);
      if (changed.changes !== 1) return fail("RECOMMENDATION_WORK_STALE_FENCE");
    })();
    return signal.event_id;
  }
  recordVerification(runtimeId: string, lease: WorkLease, value: RecommendationVerificationReceipt): string {
    const prior = this.authority.db.prepare("SELECT * FROM recommendation_work_verification_receipts WHERE runtime_id=?")
      .get(runtimeId);
    if (prior !== undefined) {
      const stored = row(prior); if (stored["receipt_json"] !== canonicalize(value)) {
        return fail("RECOMMENDATION_VERIFICATION_REPLAY_CONFLICT");
      }
      return text(stored["receipt_id"]);
    }
    const current = this.leased(runtimeId, lease); const identity = this.identity(current);
    const verifier = row(this.authority.db.prepare("SELECT * FROM recommendation_work_verifiers WHERE key_id=?")
      .get(value.key_id), "RECOMMENDATION_VERIFICATION_INVALID");
    const receipt = verifyRecommendationReceipt(value, text(verifier["public_key_pem"]), this.clock());
    const dispatchRow = row(this.authority.db.prepare(`SELECT receipt_id,receipt_json
      FROM recommendation_work_dispatch_receipts WHERE runtime_id=?`).get(runtimeId), "RECOMMENDATION_DISPATCH_REQUIRED");
    const dispatch = row(JSON.parse(text(dispatchRow["receipt_json"])));
    const progress = row(this.authority.db.prepare(`SELECT signal_json FROM recommendation_work_progress
      WHERE runtime_id=? ORDER BY sequence DESC LIMIT 1`).get(runtimeId), "RECOMMENDATION_TERMINAL_PROGRESS_REQUIRED");
    const signal = row(JSON.parse(text(progress["signal_json"])));
    if (receipt.runtime_id !== runtimeId || receipt.run_id !== identity.run_id
      || receipt.workflow_digest !== identity.workflow_digest
      || receipt.verification_request_id !== identity.verification_request_id
      || receipt.dispatch_receipt_id !== dispatchRow["receipt_id"]
      || receipt.incarnation_id !== dispatch["incarnation_id"] || signal["state"] !== "stopped"
      || signal["incarnation_id"] !== receipt.incarnation_id
      || receipt.verifier_principal_id !== verifier["principal_id"]
      || receipt.verifier_principal_id === identity.implementer_principal_id
      || receipt.verifier_principal_id === identity.correlation["requested_by_principal_id"]
      || receipt.key_id === signal["key_id"] || receipt.verifier_session_id === dispatch["session_id"]
      || receipt.verifier_incarnation_id === dispatch["incarnation_id"]) {
      return fail("RECOMMENDATION_VERIFICATION_BINDING_INVALID");
    }
    this.authority.db.transaction(() => {
      this.leased(runtimeId, lease); const receiptJson = canonicalize(receipt);
      this.authority.db.prepare(`INSERT INTO recommendation_work_verification_receipts(receipt_id,runtime_id,
        verification_request_id,receipt_json,receipt_digest,decision,artifact_digest,test_digest,evidence_digest,
        commit_digest,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(receipt.receipt_id, runtimeId,
        receipt.verification_request_id, receiptJson, persistenceHash(receipt), receipt.decision,
        receipt.artifact_digest, receipt.test_digest, receipt.evidence_digest, receipt.commit_digest, this.clock().toISOString());
      if (receipt.decision === "REJECT") this.negative(runtimeId, "verifier_reject", receipt.evidence_digest);
      const changed = this.authority.db.prepare(`UPDATE recommendation_work_runtimes SET state=?,failure_code=?,updated_at=?
        WHERE runtime_id=? AND lease_fence=?`).run(receipt.decision === "PASS" ? "verified" : "failed",
        receipt.decision === "PASS" ? null : "VERIFIER_REJECT", this.clock().toISOString(), runtimeId, lease.fence);
      if (changed.changes !== 1) return fail("RECOMMENDATION_WORK_STALE_FENCE");
      if (receipt.decision === "REJECT") {
        const result: RecommendationWorkSettlement = { settlement_id:
          `settlement:${persistenceHash({ runtime_id: runtimeId, outcome: "failed" }).slice(7)}`,
          runtime_id: runtimeId, state: "failed", candidate: null };
        this.authority.db.prepare(`INSERT INTO recommendation_work_settlements
          (settlement_id,runtime_id,outcome,settlement_json,settlement_digest,created_at) VALUES(?,?,?,?,?,?)`)
          .run(result.settlement_id, runtimeId, "failed", canonicalize(result), persistenceHash(result), this.clock().toISOString());
        this.authority.db.prepare(`UPDATE workflow_runs SET state='failed',current_node='fail',completed_at=?,updated_at=?,
          failure_code='VERIFIER_REJECT' WHERE run_id=? AND state NOT IN ('completed','failed','cancelled')`)
          .run(this.clock().toISOString(), this.clock().toISOString(), identity.run_id);
      }
    })();
    return receipt.receipt_id;
  }
  settle(runtimeId: string, lease: WorkLease): RecommendationWorkSettlement {
    const prior = this.authority.db.prepare("SELECT * FROM recommendation_work_settlements WHERE runtime_id=?")
      .get(runtimeId);
    if (prior !== undefined) return settlement(row(prior));
    const current = this.leased(runtimeId, lease); if (current["state"] !== "verified") {
      return fail("RECOMMENDATION_WORK_NOT_VERIFIED");
    }
    const identity = this.identity(current);
    const verification = row(this.authority.db.prepare(`SELECT * FROM recommendation_work_verification_receipts
      WHERE runtime_id=? AND decision='PASS'`).get(runtimeId), "RECOMMENDATION_WORK_NOT_VERIFIED");
    const receipt = row(JSON.parse(text(verification["receipt_json"])));
    const dispatch = row(this.authority.db.prepare("SELECT receipt_json FROM recommendation_work_dispatch_receipts WHERE runtime_id=?")
      .get(runtimeId)); const dispatchReceipt = row(JSON.parse(text(dispatch["receipt_json"])));
    const progress = row(this.authority.db.prepare(`SELECT event_id,signal_digest FROM recommendation_work_progress
      WHERE runtime_id=? ORDER BY sequence DESC LIMIT 1`).get(runtimeId));
    const candidate = { schema_version: 1, kind: "verified_outcome", runtime_id: runtimeId,
      recommendation_id: identity.correlation["recommendation_id"], action_rank: identity.correlation["action_rank"],
      run_id: identity.run_id, workflow_digest: identity.workflow_digest,
      correlation_digest: persistenceHash(identity.correlation), commit_digest: receipt["commit_digest"],
      artifact_digest: verification["artifact_digest"], test_digest: verification["test_digest"],
      verifier_evidence_digest: verification["evidence_digest"], verifier_receipt_id: verification["receipt_id"],
      source_refs: [identity.request_id, identity.receipt_id, dispatchReceipt["receipt_id"], progress["event_id"]],
      dispatch_digest: persistenceHash(dispatchReceipt), progress_digest: progress["signal_digest"] };
    const settlementId = `settlement:${persistenceHash({ runtime_id: runtimeId, outcome: "completed" }).slice(7)}`;
    const result: RecommendationWorkSettlement = { settlement_id: settlementId, runtime_id: runtimeId,
      state: "completed", candidate };
    this.authority.db.transaction(() => {
      this.leased(runtimeId, lease); const now = this.clock().toISOString();
      this.authority.db.prepare(`INSERT INTO recommendation_work_settlements
        (settlement_id,runtime_id,outcome,settlement_json,settlement_digest,created_at) VALUES(?,?,?,?,?,?)`)
        .run(settlementId, runtimeId, "completed", canonicalize(result), persistenceHash(result), now);
      const candidateDigest = persistenceHash(candidate);
      this.authority.db.prepare(`INSERT INTO recommendation_verified_outcomes
        (candidate_id,runtime_id,payload_json,payload_digest,created_at) VALUES(?,?,?,?,?)`)
        .run(`verified-outcome:${candidateDigest.slice(7)}`, runtimeId, canonicalize(candidate), candidateDigest, now);
      const changed = this.authority.db.prepare(`UPDATE recommendation_work_runtimes
        SET state='completed',updated_at=? WHERE runtime_id=? AND lease_fence=? AND state='verified'`)
        .run(now, runtimeId, lease.fence);
      if (changed.changes !== 1) return fail("RECOMMENDATION_WORK_TERMINAL_RACE");
      this.authority.db.prepare(`UPDATE workflow_runs SET state='completed',current_node='complete',completed_at=?,updated_at=?
        WHERE run_id=? AND state NOT IN ('completed','failed','cancelled')`).run(now, now, identity.run_id);
    })();
    return result;
  }
  cancel(runtimeId: string, lease: WorkLease, reason: string): RecommendationWorkSettlement {
    const prior = this.authority.db.prepare("SELECT * FROM recommendation_work_settlements WHERE runtime_id=?").get(runtimeId);
    if (prior !== undefined) return settlement(row(prior));
    const current = this.leased(runtimeId, lease); const identity = this.identity(current);
    const settlementId = `settlement:${persistenceHash({ runtime_id: runtimeId, outcome: "cancelled", reason }).slice(7)}`;
    const result: RecommendationWorkSettlement = { settlement_id: settlementId, runtime_id: runtimeId,
      state: "cancelled", candidate: null };
    this.authority.db.transaction(() => {
      this.leased(runtimeId, lease); const now = this.clock().toISOString();
      const changed = this.authority.db.prepare(`UPDATE recommendation_work_runtimes
        SET state='cancelled',failure_code=?,updated_at=? WHERE runtime_id=? AND lease_fence=?
          AND state NOT IN ('dispatching','completed','failed','cancelled')`).run(reason, now, runtimeId, lease.fence);
      if (changed.changes !== 1) return fail("RECOMMENDATION_WORK_TERMINAL_RACE");
      this.authority.db.prepare(`INSERT INTO recommendation_work_settlements
        (settlement_id,runtime_id,outcome,settlement_json,settlement_digest,created_at) VALUES(?,?,?,?,?,?)`)
        .run(settlementId, runtimeId, "cancelled", canonicalize(result), persistenceHash(result), now);
      this.authority.db.prepare(`UPDATE workflow_runs SET state='cancelled',completed_at=?,updated_at=?,failure_code=?
        WHERE run_id=? AND state NOT IN ('completed','failed','cancelled')`).run(now, now, reason, identity.run_id);
    })();
    return result;
  }
  status(runtimeId: string): Readonly<Record<string, unknown>> {
    const current = row(this.authority.db.prepare("SELECT * FROM recommendation_work_runtimes WHERE runtime_id=?").get(runtimeId));
    const settlementRow = this.authority.db.prepare("SELECT settlement_json FROM recommendation_work_settlements WHERE runtime_id=?")
      .get(runtimeId);
    return { runtime_id: runtimeId, state: current["state"], failure_code: current["failure_code"],
      dispatch_attempts: current["dispatch_attempts"], recovery_attempts: current["recovery_attempts"],
      progress_sequence: current["progress_sequence"], next_operator_action: current["state"] === "blocked"
        ? "reconcile_exact_receipt" : null, settlement: settlementRow === undefined ? null
          : JSON.parse(text(row(settlementRow)["settlement_json"])) };
  }
}
