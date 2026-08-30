import { canonicalize } from "./canonical.js";
import { parseCompletion } from "./recommendation-work-crypto.js";
import { RecommendationWorkRecoveryRuntime } from "./recommendation-work-recovery.js";
import { persistenceHash } from "./personal-persistence-values.js";
import { closedRecord } from "./task25-closed-input.js";
import { workFail, workRow, workText } from "./recommendation-work-dispatch.js";
import type { RecommendationCompletion, WorkLease } from "./recommendation-work-types.js";

export class RecommendationWorkProgressRuntime extends RecommendationWorkRecoveryRuntime {
  recordNonterminal(runtimeId: string, lease: WorkLease,
    event: { readonly event_id: string; readonly kind: "worker_done" | "idle" | "prompt" | "self_review" }): string {
    const prior = this.authority.db.prepare("SELECT * FROM recommendation_work_nonterminal_events WHERE event_id=?")
      .get(event.event_id);
    if (prior !== undefined) {
      const stored = workRow(prior);
      if (stored["runtime_id"] !== runtimeId || stored["kind"] !== event.kind) {
        return workFail("RECOMMENDATION_WORK_EVENT_CONFLICT");
      }
      return String(stored["kind"]);
    }
    this.leased(runtimeId, lease);
    this.authority.db.prepare(`INSERT INTO recommendation_work_nonterminal_events
      (event_id,runtime_id,kind,created_at) VALUES(?,?,?,?)`)
      .run(event.event_id, runtimeId, event.kind, this.clock().toISOString());
    return event.kind;
  }
  recordProgress(runtimeId: string, lease: WorkLease, value: RecommendationCompletion): string {
    const header = closedRecord(value); const provider = header["provider"];
    if (provider !== "codex" && provider !== "claude") return workFail("RECOMMENDATION_PROGRESS_INVALID");
    const completion = parseCompletion(value, { publicKey: this.providerKey(workText(header["key_id"]),
      provider, "progress-signal"), now: this.clock() });
    const existing = this.authority.db.prepare("SELECT * FROM recommendation_work_progress WHERE event_id=?")
      .get(completion.event_id);
    if (existing !== undefined) {
      const stored = workRow(existing); const active = workRow(this.authority.db.prepare(
        "SELECT current_dispatch_receipt_id FROM recommendation_work_runtimes WHERE runtime_id=?",
      ).get(runtimeId));
      if (stored["runtime_id"] !== runtimeId || stored["signal_json"] !== canonicalize(completion)
        || active["current_dispatch_receipt_id"] !== completion.dispatch_receipt_id) {
        return workFail("RECOMMENDATION_PROGRESS_REPLAY_CONFLICT");
      }
      return completion.event_id;
    }
    const current = this.leased(runtimeId, lease); const identity = this.identity(current);
    const dispatchRow = workRow(this.authority.db.prepare(`SELECT receipt_id,receipt_json,receipt_digest
      FROM recommendation_work_dispatch_receipts WHERE receipt_id=? AND runtime_id=?`)
      .get(current["current_dispatch_receipt_id"], runtimeId), "RECOMMENDATION_DISPATCH_REQUIRED");
    const dispatch = workRow(JSON.parse(workText(dispatchRow["receipt_json"])));
    const sequence = Number(completion.sequence); const expected = Number(current["progress_sequence"]) + 1;
    if (completion.runtime_id !== runtimeId || completion.dispatch_receipt_id !== dispatchRow["receipt_id"]
      || completion.dispatch_receipt_digest !== dispatchRow["receipt_digest"] || completion.provider !== dispatch["provider"]
      || completion.worktree_id !== dispatch["worktree_id"] || completion.terminal_id !== dispatch["terminal_id"]
      || completion.session_id !== dispatch["session_id"] || completion.incarnation_id !== dispatch["incarnation_id"]
      || completion.pty_id !== dispatch["pty_id"] || sequence !== expected
      || completion.key_id === dispatch["key_id"]) return workFail("RECOMMENDATION_PROGRESS_INVALID");
    const priorRequests = Number((this.authority.db.prepare(`SELECT COUNT(*) count
      FROM recommendation_work_verification_requests WHERE runtime_id=?`).get(runtimeId) as { count: number }).count);
    const verificationRequestId = priorRequests === 0 ? identity.verification_request_id
      : `verification:${persistenceHash({ runtime_id: runtimeId, receipt: dispatchRow["receipt_digest"] }).slice(7)}`;
    const request = { schema_version: 1, verification_request_id: verificationRequestId,
      runtime_id: runtimeId, run_id: identity.run_id, workflow_digest: identity.workflow_digest,
      task_id: identity.task_id, dispatch_receipt_id: dispatchRow["receipt_id"],
      dispatch_receipt_digest: dispatchRow["receipt_digest"], provider: completion.provider,
      worktree_id: completion.worktree_id, terminal_id: completion.terminal_id,
      session_id: completion.session_id, incarnation_id: completion.incarnation_id, pty_id: completion.pty_id,
      progress_event_id: completion.event_id, progress_sequence: completion.sequence,
      progress_key_id: completion.key_id,
      commit_digest: completion.commit_digest, artifact_digest: completion.artifact_digest,
      test_digest: completion.test_digest, evidence_digest: completion.evidence_digest };
    const requestDigest = persistenceHash(request); const now = this.clock().toISOString();
    this.authority.db.transaction(() => {
      this.leased(runtimeId, lease); const signalJson = canonicalize(completion);
      this.authority.db.prepare(`INSERT INTO recommendation_work_progress(event_id,runtime_id,dispatch_receipt_id,
        sequence,signal_json,signal_digest,observed_at) VALUES(?,?,?,?,?,?,?)`).run(completion.event_id, runtimeId,
        dispatchRow["receipt_id"], sequence, signalJson, persistenceHash(completion), completion.observed_at);
      this.authority.db.prepare(`INSERT INTO recommendation_work_verification_requests(verification_request_id,
        runtime_id,run_id,dispatch_receipt_id,request_json,request_digest,commit_digest,artifact_digest,test_digest,
        evidence_digest,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(verificationRequestId, runtimeId,
        identity.run_id, dispatchRow["receipt_id"], canonicalize(request), requestDigest, completion.commit_digest,
        completion.artifact_digest, completion.test_digest, completion.evidence_digest, now);
      const changed = this.authority.db.prepare(`UPDATE recommendation_work_runtimes SET state='progressed',
        progress_sequence=?,updated_at=? WHERE runtime_id=? AND lease_fence=? AND state='dispatched'`)
        .run(sequence, now, runtimeId, lease.fence);
      if (changed.changes !== 1) return workFail("RECOMMENDATION_WORK_TERMINAL_RACE");
    })();
    this.checkpoint("progress_committed");
    return completion.event_id;
  }
}
