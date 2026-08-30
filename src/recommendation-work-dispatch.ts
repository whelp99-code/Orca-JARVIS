import { createPublicKey } from "node:crypto";
import { canonicalize } from "./canonical.js";
import { type AuthorityDb, JarvisError } from "./db.js";
import { persistenceHash } from "./personal-persistence-values.js";
import { reconstructRecommendationWork, prepared, type RecommendationWorkIdentity } from "./recommendation-work-identity.js";
import type {
  DispatchAdapter, DispatchIntent, DispatchOutcome, DispatchReceipt, PreparedRecommendationWork, WorkLease,
} from "./recommendation-work-types.js";

const LEASE_MS = 60_000;
type Row = Readonly<Record<string, unknown>>;
function fail(code: string): never { throw new JarvisError(code); }
function row(value: unknown, code = "RECOMMENDATION_WORK_NOT_FOUND"): Row {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Row : fail(code);
}
function text(value: unknown): string { return typeof value === "string" && value.length > 0 ? value : fail("RECOMMENDATION_WORK_STATE_INVALID"); }
export function parseDispatchReceipt(value: unknown, intent: DispatchIntent): DispatchReceipt {
  const item = row(value, "RECOMMENDATION_DISPATCH_RECEIPT_INVALID");
  const keys = ["receipt_id", "intent_id", "task_id", "provider", "worktree_id", "terminal_id", "session_id",
    "incarnation_id", "pty_id", "accepted_at"] as const;
  if (Object.keys(item).length !== keys.length || Object.keys(item).some(key => !keys.includes(key as typeof keys[number]))) {
    return fail("RECOMMENDATION_DISPATCH_RECEIPT_INVALID");
  }
  if (item["intent_id"] !== intent.intent_id || item["task_id"] !== intent.task_id
    || (item["provider"] !== "codex" && item["provider"] !== "claude")) {
    return fail("RECOMMENDATION_DISPATCH_RECEIPT_INVALID");
  }
  const accepted = text(item["accepted_at"]); if (new Date(accepted).toISOString() !== accepted) return fail("RECOMMENDATION_DISPATCH_RECEIPT_INVALID");
  return { receipt_id: text(item["receipt_id"]), intent_id: intent.intent_id, task_id: intent.task_id,
    provider: item["provider"], worktree_id: text(item["worktree_id"]), terminal_id: text(item["terminal_id"]),
    session_id: text(item["session_id"]), incarnation_id: text(item["incarnation_id"]),
    pty_id: text(item["pty_id"]), accepted_at: accepted };
}
export class RecommendationWorkDispatchRuntime {
  constructor(protected readonly authority: AuthorityDb, protected readonly clock: () => Date = () => new Date()) {}
  registerProgressKey(input: { readonly key_id: string; readonly provider: "codex" | "claude";
    readonly public_key_pem: string; readonly not_before: string; readonly expires_at: string }): void {
    const now = this.clock().toISOString(); const key = createPublicKey(input.public_key_pem);
    if (key.asymmetricKeyType !== "ed25519" || Date.parse(input.not_before) > Date.parse(input.expires_at)) {
      return fail("RECOMMENDATION_PROGRESS_KEY_INVALID");
    }
    const prior = this.authority.db.prepare("SELECT * FROM recommendation_work_progress_keys WHERE key_id=?").get(input.key_id);
    if (prior !== undefined) {
      const stored = row(prior); if (stored["provider"] !== input.provider || stored["public_key_pem"] !== input.public_key_pem
        || stored["not_before"] !== input.not_before || stored["expires_at"] !== input.expires_at) {
        return fail("RECOMMENDATION_PROGRESS_KEY_CONFLICT");
      }
      return;
    }
    this.authority.db.prepare(`INSERT INTO recommendation_work_progress_keys
      (key_id,provider,public_key_pem,not_before,expires_at,created_at) VALUES(?,?,?,?,?,?)`)
      .run(input.key_id, input.provider, input.public_key_pem, input.not_before, input.expires_at, now);
  }
  registerVerifier(input: { readonly key_id: string; readonly principal_id: string; readonly public_key_pem: string }): void {
    const key = createPublicKey(input.public_key_pem); if (key.asymmetricKeyType !== "ed25519") return fail("RECOMMENDATION_VERIFIER_INVALID");
    const prior = this.authority.db.prepare("SELECT * FROM recommendation_work_verifiers WHERE key_id=?").get(input.key_id);
    if (prior !== undefined) {
      const stored = row(prior); if (stored["principal_id"] !== input.principal_id
        || stored["public_key_pem"] !== input.public_key_pem) return fail("RECOMMENDATION_VERIFIER_CONFLICT");
      return;
    }
    this.authority.db.prepare(`INSERT INTO recommendation_work_verifiers
      (key_id,principal_id,public_key_pem,created_at) VALUES(?,?,?,?)`)
      .run(input.key_id, input.principal_id, input.public_key_pem, this.clock().toISOString());
  }
  prepare(requestId: string): PreparedRecommendationWork {
    const identity = reconstructRecommendationWork(this.authority, requestId); const identityJson = canonicalize(identity.correlation);
    const identityDigest = persistenceHash(identity.correlation); const now = this.clock().toISOString();
    const transaction = this.authority.db.transaction(() => {
      const prior = this.authority.db.prepare("SELECT * FROM recommendation_work_runtimes WHERE runtime_id=?").get(identity.runtime_id);
      if (prior !== undefined) {
        const stored = row(prior); if (stored["identity_json"] !== identityJson || stored["identity_digest"] !== identityDigest) {
          return fail("RECOMMENDATION_WORK_REPLAY_CONFLICT");
        }
        return String(stored["state"]);
      }
      this.authority.db.prepare(`INSERT INTO recommendation_work_runtimes(runtime_id,request_id,run_id,identity_json,
        identity_digest,workflow_digest,dispatch_intent_id,verification_request_id,state,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(identity.runtime_id, identity.request_id, identity.run_id, identityJson,
        identityDigest, identity.workflow_digest, identity.dispatch_intent_id, identity.verification_request_id,
        "prepared", now, now); return "prepared";
    });
    return prepared(identity, transaction());
  }
  claim(runtimeId: string, owner: string): WorkLease {
    const now = this.clock();
    return this.authority.db.transaction(() => {
      const current = row(this.authority.db.prepare("SELECT * FROM recommendation_work_runtimes WHERE runtime_id=?").get(runtimeId));
      const budget = row(this.identity(current).correlation["budget"]); const deadline = Date.parse(text(budget["deadline"]));
      if (deadline <= now.getTime()) return fail("RECOMMENDATION_WORK_DEADLINE_EXHAUSTED");
      const expires = new Date(Math.min(now.getTime() + LEASE_MS, deadline)).toISOString();
      if (["completed", "failed", "cancelled"].includes(String(current["state"]))) return fail("RECOMMENDATION_WORK_TERMINAL");
      if (typeof current["lease_expires_at"] === "string" && Date.parse(current["lease_expires_at"]) > now.getTime()) {
        return fail("RECOMMENDATION_WORK_LEASE_HELD");
      }
      const fence = Number(current["lease_fence"]) + 1; const changed = this.authority.db.prepare(`UPDATE recommendation_work_runtimes
        SET lease_owner=?,lease_fence=?,lease_expires_at=?,updated_at=? WHERE runtime_id=? AND lease_fence=?`)
        .run(owner, fence, expires, now.toISOString(), runtimeId, current["lease_fence"]);
      if (changed.changes !== 1) return fail("RECOMMENDATION_WORK_LEASE_HELD");
      return { runtime_id: runtimeId, owner, fence, expires_at: expires };
    })();
  }
  protected leased(runtimeId: string, lease: WorkLease): Row {
    const current = row(this.authority.db.prepare("SELECT * FROM recommendation_work_runtimes WHERE runtime_id=?").get(runtimeId));
    if (lease.runtime_id !== runtimeId || current["lease_owner"] !== lease.owner
      || Number(current["lease_fence"]) !== lease.fence || current["lease_expires_at"] !== lease.expires_at
      || Date.parse(lease.expires_at) <= this.clock().getTime()) return fail("RECOMMENDATION_WORK_STALE_FENCE");
    if (["completed", "failed", "cancelled"].includes(String(current["state"]))) return fail("RECOMMENDATION_WORK_TERMINAL");
    return current;
  }
  protected identity(current: Row): RecommendationWorkIdentity {
    return reconstructRecommendationWork(this.authority, text(current["request_id"]));
  }
  protected intent(current: Row): DispatchIntent {
    const identity = this.identity(current); return { runtime_id: identity.runtime_id, intent_id: identity.dispatch_intent_id,
      task_id: identity.task_id, run_id: identity.run_id, workflow_digest: identity.workflow_digest,
      idempotency_key: text(identity.correlation["idempotency_key"]) };
  }
  protected negative(runtimeId: string, reason: string, material: unknown): void {
    const evidenceDigest = persistenceHash({ runtime_id: runtimeId, reason, material });
    this.authority.db.prepare(`INSERT OR IGNORE INTO recommendation_work_negative_evidence
      (evidence_id,runtime_id,reason_code,evidence_digest,created_at) VALUES(?,?,?,?,?)`)
      .run(`negative:${evidenceDigest.slice(7)}`, runtimeId, reason, evidenceDigest, this.clock().toISOString());
  }
  async dispatch(runtimeId: string, lease: WorkLease, adapter: DispatchAdapter): Promise<{
    readonly state: string; readonly receipt: DispatchReceipt | null; readonly verification_request_id: string;
  }> {
    const current = this.leased(runtimeId, lease); const identity = this.identity(current);
    const existing = this.authority.db.prepare(
      "SELECT receipt_json FROM recommendation_work_dispatch_receipts WHERE runtime_id=?",
    ).get(runtimeId);
    if (existing !== undefined) return { state: "dispatched", receipt: JSON.parse(text(row(existing)["receipt_json"])),
      verification_request_id: identity.verification_request_id };
    if (current["state"] === "dispatching") {
      this.authority.db.prepare(`UPDATE recommendation_work_runtimes SET state='blocked',failure_code='DISPATCH_UNCERTAIN',
        updated_at=? WHERE runtime_id=? AND lease_fence=? AND state='dispatching'`)
        .run(this.clock().toISOString(), runtimeId, lease.fence);
      this.negative(runtimeId, "crash_after_observable_send", { fence: lease.fence });
      return fail("RECOMMENDATION_DISPATCH_UNCERTAIN");
    }
    if (current["state"] === "blocked") return fail("RECOMMENDATION_DISPATCH_UNCERTAIN");
    const budget = row(identity.correlation["budget"]); const attempt = Number(current["dispatch_attempts"]) + 1;
    if (attempt > Number(budget["max_attempts_per_node"])
      || Date.parse(text(budget["deadline"])) <= this.clock().getTime()) {
      this.negative(runtimeId, "dispatch_budget_exhausted", { attempt });
      this.authority.db.prepare(`UPDATE recommendation_work_runtimes SET state='failed',failure_code=?,updated_at=?
        WHERE runtime_id=? AND lease_fence=?`).run("DISPATCH_BUDGET_EXHAUSTED", this.clock().toISOString(), runtimeId, lease.fence);
      return fail("RECOMMENDATION_DISPATCH_BUDGET_EXHAUSTED");
    }
    const attemptId = `dispatch-attempt:${persistenceHash({ runtime_id: runtimeId, attempt }).slice(7)}`;
    this.authority.db.prepare(`INSERT INTO recommendation_work_dispatch_attempts
      (attempt_id,runtime_id,lease_fence,attempt,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?)`)
      .run(attemptId, runtimeId, lease.fence, attempt, "prepared", this.clock().toISOString(), this.clock().toISOString());
    this.authority.db.prepare(`UPDATE recommendation_work_runtimes SET dispatch_attempts=?,updated_at=?
      WHERE runtime_id=? AND lease_fence=?`).run(attempt, this.clock().toISOString(), runtimeId, lease.fence);
    const intent = this.intent(current); let eventId: string;
    try { eventId = text((await adapter.subscribe(intent)).event_id); }
    catch (error) {
      const material = error instanceof Error ? error.name : typeof error; this.dispatchFailure(runtimeId, lease, attemptId,
        "not_sent", "subscription_failed", material); return { state: "prepared", receipt: null,
        verification_request_id: identity.verification_request_id };
    }
    const invoking = this.authority.db.prepare(`UPDATE recommendation_work_runtimes
      SET state='dispatching',updated_at=? WHERE runtime_id=? AND lease_fence=?
        AND state='prepared'`).run(this.clock().toISOString(), runtimeId, lease.fence);
    if (invoking.changes !== 1) return fail("RECOMMENDATION_WORK_TERMINAL_RACE");
    let outcome: DispatchOutcome;
    try { outcome = await adapter.trigger(intent); }
    catch (error) {
      const material = error instanceof Error ? error.name : typeof error; this.dispatchFailure(runtimeId, lease, attemptId,
        "uncertain", "trigger_threw", material, eventId); return { state: "blocked", receipt: null,
        verification_request_id: identity.verification_request_id };
    }
    switch (outcome.kind) {
      case "not_sent":
        this.dispatchFailure(runtimeId, lease, attemptId, "not_sent", outcome.reason, outcome, eventId);
        return { state: "prepared", receipt: null, verification_request_id: identity.verification_request_id };
      case "uncertain":
        this.dispatchFailure(runtimeId, lease, attemptId, "uncertain", outcome.reason, outcome, eventId);
        return { state: "blocked", receipt: null, verification_request_id: identity.verification_request_id };
      case "accepted": {
        const receipt = parseDispatchReceipt(outcome.receipt, intent); const receiptJson = canonicalize(receipt);
        this.authority.db.transaction(() => {
          this.leased(runtimeId, lease);
          this.authority.db.prepare(`UPDATE recommendation_work_dispatch_attempts
            SET state='accepted',event_id=?,updated_at=? WHERE attempt_id=? AND lease_fence=?`)
            .run(eventId, this.clock().toISOString(), attemptId, lease.fence);
          this.authority.db.prepare(`INSERT INTO recommendation_work_dispatch_receipts
            (receipt_id,runtime_id,attempt_id,receipt_json,receipt_digest,accepted_at) VALUES(?,?,?,?,?,?)`)
            .run(receipt.receipt_id, runtimeId, attemptId, receiptJson, persistenceHash(receipt), receipt.accepted_at);
          const changed = this.authority.db.prepare(`UPDATE recommendation_work_runtimes
            SET state='dispatched',current_incarnation_id=?,updated_at=? WHERE runtime_id=? AND lease_fence=?`)
            .run(receipt.incarnation_id, this.clock().toISOString(), runtimeId, lease.fence);
          if (changed.changes !== 1) return fail("RECOMMENDATION_WORK_STALE_FENCE");
        })();
        return { state: "dispatched", receipt, verification_request_id: identity.verification_request_id };
      }
      default: {
        const exhaustive: never = outcome; return exhaustive;
      }
    }
  }
  private dispatchFailure(runtimeId: string, lease: WorkLease, attemptId: string,
    state: "not_sent" | "uncertain", reason: string, material: unknown, eventId?: string): void {
    this.authority.db.transaction(() => {
      this.leased(runtimeId, lease); const evidence = persistenceHash({ runtime_id: runtimeId, reason, material });
      this.authority.db.prepare(`UPDATE recommendation_work_dispatch_attempts
        SET state=?,event_id=?,evidence_digest=?,updated_at=? WHERE attempt_id=? AND lease_fence=?`)
        .run(state, eventId ?? null, evidence, this.clock().toISOString(), attemptId, lease.fence);
      this.authority.db.prepare(`UPDATE recommendation_work_runtimes SET state=?,failure_code=?,updated_at=?
        WHERE runtime_id=? AND lease_fence=?`).run(state === "uncertain" ? "blocked" : "prepared",
        state === "uncertain" ? "DISPATCH_UNCERTAIN" : null, this.clock().toISOString(), runtimeId, lease.fence);
      this.negative(runtimeId, reason, material);
    })();
  }
}
