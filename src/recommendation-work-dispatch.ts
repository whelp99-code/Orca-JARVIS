import { canonicalize } from "./canonical.js";
import { type AuthorityDb, JarvisError } from "./db.js";
import { persistenceHash } from "./personal-persistence-values.js";
import {
  reconstructRecommendationWork, prepared, type RecommendationWorkIdentity,
} from "./recommendation-work-identity.js";
import type { DispatchIntent, PreparedRecommendationWork, WorkLease } from "./recommendation-work-types.js";

const LEASE_MS = 60_000;
export type RecommendationWorkFaultPoint = "attempt_committed" | "dispatch_committed"
  | "progress_committed" | "verification_committed" | "settlement_committed";
export type WorkRow = Readonly<Record<string, unknown>>;
export function workFail(code: string): never { throw new JarvisError(code); }
export function workRow(value: unknown, code = "RECOMMENDATION_WORK_NOT_FOUND"): WorkRow {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as WorkRow : workFail(code);
}
export function workText(value: unknown): string {
  return typeof value === "string" && value.length > 0
    ? value : workFail("RECOMMENDATION_WORK_STATE_INVALID");
}
export class RecommendationWorkDispatchRuntime {
  constructor(protected readonly authority: AuthorityDb, protected readonly clock: () => Date = () => new Date(),
    private readonly fault?: (point: RecommendationWorkFaultPoint) => void) {}
  protected checkpoint(point: RecommendationWorkFaultPoint): void { this.fault?.(point); }
  prepare(requestId: string): PreparedRecommendationWork {
    const identity = reconstructRecommendationWork(this.authority, requestId, this.clock());
    const identityJson = canonicalize(identity.correlation); const identityDigest = persistenceHash(identity.correlation);
    const now = this.clock().toISOString();
    const transaction = this.authority.db.transaction(() => {
      const prior = this.authority.db.prepare("SELECT * FROM recommendation_work_runtimes WHERE runtime_id=?")
        .get(identity.runtime_id);
      if (prior !== undefined) {
        const stored = workRow(prior);
        if (stored["identity_json"] !== identityJson || stored["identity_digest"] !== identityDigest) {
          return workFail("RECOMMENDATION_WORK_REPLAY_CONFLICT");
        }
        return String(stored["state"]);
      }
      this.authority.db.prepare(`INSERT INTO recommendation_work_runtimes(runtime_id,request_id,run_id,
        identity_json,identity_digest,workflow_digest,dispatch_intent_id,verification_request_id,state,
        created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(identity.runtime_id, identity.request_id,
        identity.run_id, identityJson, identityDigest, identity.workflow_digest, identity.dispatch_intent_id,
        identity.verification_request_id, "prepared", now, now);
      return "prepared";
    });
    return prepared(identity, transaction());
  }
  claim(runtimeId: string, owner: string): WorkLease {
    const now = this.clock();
    return this.authority.db.transaction(() => {
      const current = workRow(this.authority.db.prepare(
        "SELECT * FROM recommendation_work_runtimes WHERE runtime_id=?",
      ).get(runtimeId));
      const budget = workRow(this.identity(current).correlation["budget"]);
      const deadline = Date.parse(workText(budget["deadline"]));
      if (deadline <= now.getTime()) return workFail("RECOMMENDATION_WORK_DEADLINE_EXHAUSTED");
      const expires = new Date(Math.min(now.getTime() + LEASE_MS, deadline)).toISOString();
      if (["completed", "failed", "cancelled"].includes(String(current["state"]))) {
        return workFail("RECOMMENDATION_WORK_TERMINAL");
      }
      if (typeof current["lease_expires_at"] === "string"
        && Date.parse(current["lease_expires_at"]) > now.getTime()) return workFail("RECOMMENDATION_WORK_LEASE_HELD");
      const fence = Number(current["lease_fence"]) + 1;
      const changed = this.authority.db.prepare(`UPDATE recommendation_work_runtimes SET lease_owner=?,
        lease_fence=?,lease_expires_at=?,updated_at=? WHERE runtime_id=? AND lease_fence=?`)
        .run(owner, fence, expires, now.toISOString(), runtimeId, current["lease_fence"]);
      if (changed.changes !== 1) return workFail("RECOMMENDATION_WORK_LEASE_HELD");
      return { runtime_id: runtimeId, owner, fence, expires_at: expires };
    })();
  }
  protected leased(runtimeId: string, lease: WorkLease): WorkRow {
    const current = workRow(this.authority.db.prepare(
      "SELECT * FROM recommendation_work_runtimes WHERE runtime_id=?",
    ).get(runtimeId));
    if (lease.runtime_id !== runtimeId || current["lease_owner"] !== lease.owner
      || Number(current["lease_fence"]) !== lease.fence || current["lease_expires_at"] !== lease.expires_at
      || Date.parse(lease.expires_at) <= this.clock().getTime()) return workFail("RECOMMENDATION_WORK_STALE_FENCE");
    if (["completed", "failed", "cancelled"].includes(String(current["state"]))) {
      return workFail("RECOMMENDATION_WORK_TERMINAL");
    }
    this.identity(current);
    return current;
  }
  protected identity(current: WorkRow): RecommendationWorkIdentity {
    return reconstructRecommendationWork(this.authority, workText(current["request_id"]), this.clock());
  }
  protected intent(current: WorkRow, attemptId: string): DispatchIntent {
    const identity = this.identity(current);
    return { runtime_id: identity.runtime_id, intent_id: identity.dispatch_intent_id, attempt_id: attemptId,
      task_id: identity.task_id, run_id: identity.run_id, workflow_digest: identity.workflow_digest,
      idempotency_key: workText(identity.correlation["idempotency_key"]) };
  }
  protected providerKey(keyId: string, provider: "codex" | "claude",
    purpose: "progress-signal" | "authority-receipt"): string {
    const current = this.clock().toISOString();
    const key = workRow(this.authority.db.prepare(`SELECT k.public_key_pem FROM pre_gjc_progress_keys k
      LEFT JOIN pre_gjc_key_revocations r ON r.key_id=k.key_id AND r.provider=k.provider AND r.purpose=k.purpose
      WHERE k.key_id=? AND k.provider=? AND k.purpose=? AND k.not_before<=? AND k.expires_at>?
        AND r.key_id IS NULL`).get(keyId, provider, purpose, current, current), "RECOMMENDATION_PROVIDER_KEY_INVALID");
    return workText(key["public_key_pem"]);
  }
  protected negative(runtimeId: string, reason: string, material: unknown): void {
    const evidenceDigest = persistenceHash({ runtime_id: runtimeId, reason, material });
    this.authority.db.prepare(`INSERT OR IGNORE INTO recommendation_work_negative_evidence
      (evidence_id,runtime_id,reason_code,evidence_digest,created_at) VALUES(?,?,?,?,?)`)
      .run(`negative:${evidenceDigest.slice(7)}`, runtimeId, reason, evidenceDigest, this.clock().toISOString());
  }
}
