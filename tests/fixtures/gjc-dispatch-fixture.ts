import type { AuthorityDb } from "../../src/db.js";
import { decisionReceiptFor, policyKey, snapshot } from "../helpers.js";

/** A real authority/redemption chain, with no coordinator call or work acknowledgement. */
export function seedGjcDispatch(db: AuthorityDb, authorization: "code" | "both" = "code") {
  const census = snapshot("codex", { authorization });
  db.ingest(census, policyKey(db));
  if (authorization === "both") db.approveWithReceipt("codex-work", decisionReceiptFor(db, "codex-work"));
  const intent = db.db.prepare("SELECT * FROM gjc_intents WHERE kind='dispatch'").get() as {
    intent_id: string; continuation_id: string; payload_json: string; idempotency_key: string;
  };
  const continuation = db.db.prepare("SELECT authorization_id,authority_expires_at FROM continuation_acceptances WHERE id=?")
    .get(intent.continuation_id) as { authorization_id: string; authority_expires_at: string };
  return { ...intent, ...continuation, census };
}

export function gjcTaskFor(db: AuthorityDb, source: ReturnType<typeof seedGjcDispatch>, idempotencyKey: string) {
  const work = db.db.prepare("SELECT * FROM work_items WHERE id='codex-work'").get() as Record<string, unknown>;
  return {
    action: work.action, baseline: work.baseline, policy_hash: work.policy_hash,
    census_snapshot_hash: JSON.parse(source.payload_json).census_snapshot_hash,
    continuation_id: source.continuation_id, cwd: process.cwd(), session_id: "s",
    expiry: source.authority_expires_at, lease_epoch: work.lease_epoch, fencing_token: work.fencing_token,
    scope: JSON.parse(String(work.scope_json)), scope_digest: work.scope_digest,
    forbidden_actions: JSON.parse(String(work.forbidden_json)), forbidden_digest: work.forbidden_digest,
    budget: JSON.parse(String(work.budget_json)), budget_digest: work.budget_digest, idempotency_key: idempotencyKey,
  };
}
