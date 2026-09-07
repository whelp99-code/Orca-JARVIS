import { deterministic, JarvisError, json, same, sha, type Row } from "./authority-db-base.js";
import { GjcConfigurationAuthorityDb } from "./gjc-configuration-store.js";
import { verifyDecisionReceipt, verifyPolicyAuthorization } from "./receipt.js";
import type { CensusSnapshot, DecisionReceipt, PolicyAuthorization } from "./types.js";

function denied(): never { throw new JarvisError("GJC_DISPATCH_NOT_AUTHORIZED"); }
function object(value: unknown): Row {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Row : denied();
}
function future(value: unknown, at: Date): boolean {
  const time = typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(time) && time > at.getTime();
}

/** Reconstruct the bounded task from current authority before crossing the coordinator boundary. */
export abstract class GjcDispatchAuthorityDb extends GjcConfigurationAuthorityDb {
  abstract requireGjcIntentLease(intentId: string, fence: number, now: string): Row;

  gjcDispatchArguments(intentId: string, fence: number, expectedConfig: Row, now: string): Row {
    const intent = this.requireGjcIntentLease(intentId, fence, now);
    try {
      const config = this.gjcConfig();
      if (!config?.operational || !["revision", "config_digest", "canonical_cwd", "session_id"]
        .every(key => config[key] === expectedConfig[key])) return denied();
      if (intent.kind !== "dispatch" || typeof intent.continuation_id !== "string"
        || typeof intent.payload_json !== "string" || sha(intent.payload_json) !== intent.payload_digest
        || typeof intent.idempotency_key !== "string"
        || deterministic("gjc", intent.idempotency_key) !== intentId) return denied();
      const payload = object(JSON.parse(intent.payload_json));
      // One redeemed continuation is one external operation, even if a caller supplies another retry key.
      if (this.db.prepare(`SELECT 1 FROM gjc_intents WHERE continuation_id=? AND kind='dispatch' AND intent_id<>?
        AND (state IN ('claimed','accepted','completed','uncertain') OR receipt_json IS NOT NULL) LIMIT 1`)
        .get(intent.continuation_id, intentId)) return denied();
      const continuation = this.db.prepare("SELECT * FROM continuation_acceptances WHERE id=?")
        .get(intent.continuation_id) as Row | undefined;
      if (!continuation) return denied();
      const work = this.work(String(continuation.work_id));
      const at = new Date(now);
      this.requireDispatchAuthority(continuation, work, at);
      this.requireDispatchPayload(payload, intent, continuation, work, config);
      const source = this.db.prepare("SELECT payload_json,digest FROM census_snapshots WHERE id=?")
        .get(work.snapshot_id) as Row | undefined;
      if (!source || sha(String(source.payload_json)) !== source.digest) return denied();
      const census = JSON.parse(String(source.payload_json)) as CensusSnapshot;
      const item = census.work.find(candidate => candidate.id === work.id && candidate.proposal_hash === work.proposal_hash);
      if (!item || sha(item.action) !== work.action_digest || sha(item.scope) !== work.scope_digest
        || sha(item.budget) !== work.budget_digest || sha(item.forbidden_actions) !== work.forbidden_digest) return denied();
      const prompt = json({
        schema_version: 1, kind: "jarvis_authorized_continuation", intent_id: intentId,
        continuation_id: continuation.id, authorization_reference: continuation.authorization_id,
        authority_expires_at: continuation.authority_expires_at, census_snapshot_hash: source.digest,
        task: item,
      });
      if (Buffer.byteLength(prompt, "utf8") > 64 * 1024) throw new JarvisError("GJC_DISPATCH_PROMPT_TOO_LARGE");
      // Only the published send_prompt arguments cross MCP; authority metadata remains inside the prompt.
      return { session_id: config.session_id, prompt };
    } catch (error) {
      if (error instanceof JarvisError && error.code === "GJC_DISPATCH_PROMPT_TOO_LARGE") throw error;
      return denied();
    }
  }

  private requireDispatchAuthority(continuation: Row, work: Row, at: Date): void {
    if (!Number.isFinite(at.getTime()) || work.state !== "continued" || continuation.status !== "accepted"
      || !future(work.deadline, at) || !future(continuation.authority_expires_at, at)
      || continuation.lease_epoch !== work.lease_epoch || continuation.fencing_token !== work.fencing_token
      || continuation.baseline_digest !== sha(String(work.baseline))
      || continuation.policy_hash_bound !== work.policy_hash || continuation.action_digest_bound !== work.action_digest
      || continuation.scope_digest_bound !== work.scope_digest || continuation.budget_digest_bound !== work.budget_digest
      || this.revoked(String(continuation.authorization_id)) || !this.censusGuardsCurrent(work, at)) return denied();
    let credentialExpires: string;
    if (continuation.authorization_kind === "receipt") {
      const row = this.db.prepare(`SELECT d.payload_json FROM decision_receipts d JOIN receipt_redemptions r
        ON r.receipt_id=d.receipt_id WHERE d.receipt_id=? AND r.continuation_id=?`)
        .get(continuation.authorization_id, continuation.id) as Row | undefined;
      if (!row) return denied();
      const receipt = JSON.parse(String(row.payload_json)) as DecisionReceipt;
      if (work.authorization !== "both" || receipt.decision !== "approve"
        || receipt.receipt_id !== continuation.authorization_id || this.revoked(receipt.key_id)
        || !verifyDecisionReceipt(receipt, this.trusted(receipt.key_id, "decision", receipt.signer_principal_id), at)
        || !this.matchReceipt(work, receipt)) return denied();
      credentialExpires = receipt.expires_at;
    } else if (continuation.authorization_kind === "policy") {
      const row = this.db.prepare(`SELECT a.payload_json FROM policy_authorizations a JOIN policy_redemptions r
        ON r.authorization_id=a.id WHERE a.id=? AND r.continuation_id=?`)
        .get(continuation.authorization_id, continuation.id) as Row | undefined;
      if (!row) return denied();
      const policy = JSON.parse(String(row.payload_json)) as PolicyAuthorization;
      if (work.authorization !== "code" || policy.authorization_id !== continuation.authorization_id
        || this.revoked(policy.key_id)
        || !verifyPolicyAuthorization(policy, this.trusted(policy.key_id, "policy", "shadow-policy"), at)
        || !this.matchPolicy(work, policy)) return denied();
      credentialExpires = policy.expires_at;
    } else return denied();
    if (Date.parse(String(continuation.authority_expires_at))
      !== Math.min(Date.parse(String(work.deadline)), Date.parse(credentialExpires))) return denied();
  }

  private requireDispatchPayload(payload: Row, intent: Row, continuation: Row, work: Row, config: Row): void {
    const common = { continuation_id: continuation.id, cwd: config.canonical_cwd, session_id: config.session_id,
      census_snapshot_hash: work.snapshot_digest, expiry: continuation.authority_expires_at,
      lease_epoch: work.lease_epoch, fencing_token: work.fencing_token };
    const automatic = {
      ...common, operation_id: continuation.id,
      target: { terminal_kind: work.terminal_kind, terminal_session_id: work.terminal_session_id },
      action_hash: work.action_digest, authorization_reference: continuation.authorization_id,
    };
    const task = {
      ...common, action: work.action, baseline: work.baseline, policy_hash: work.policy_hash,
      scope: JSON.parse(String(work.scope_json)), scope_digest: work.scope_digest,
      forbidden_actions: JSON.parse(String(work.forbidden_json)), forbidden_digest: work.forbidden_digest,
      budget: JSON.parse(String(work.budget_json)), budget_digest: work.budget_digest,
      idempotency_key: intent.idempotency_key,
    };
    if (!(same(payload, automatic) && intent.idempotency_key === deterministic("gjc-dispatch", String(continuation.id)))
      && !same(payload, task)) return denied();
  }
}
