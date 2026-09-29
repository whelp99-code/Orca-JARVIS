import { createHash } from "node:crypto";
import { canonicalize } from "./canonical.js";
import { JarvisError, type AuthorityDb } from "./db.js";
import { ControlPlane, type ClaimedControlCommand } from "./control-plane.js";

const PRE_DELIVERY = new Set([
  "SECOND_BRAIN_DISCOVERY_FAILED", "SECOND_BRAIN_START_FAILED", "SECOND_BRAIN_CHILD_EXIT",
]);

export function abandonUndeliveredOutbox(authority: AuthorityDb, command: ClaimedControlCommand, now: Date): {
  readonly outbox_id: string; readonly state: "abandoned_not_delivered";
} {
  if (command.action !== "memory.outbox.abandon-not-delivered") throw new JarvisError("MEMORY_OUTBOX_ABANDON_REFUSED");
  const outboxId = command.args.outbox_id;
  if (typeof outboxId !== "string" || command.target.outbox_id !== outboxId) {
    throw new JarvisError("MEMORY_OUTBOX_ABANDON_REFUSED");
  }
  const at = now.toISOString();
  return authority.db.transaction(() => {
    const receipt = authority.db.prepare(
      `SELECT signer_principal_id,command_digest FROM control_command_receipts
       WHERE request_id=? AND decision='approve'`,
    ).get(command.request_id) as { signer_principal_id: string; command_digest: string } | undefined;
    if (receipt?.signer_principal_id !== "principal:owner" || receipt.command_digest !== command.command_digest) {
      throw new JarvisError("MEMORY_OUTBOX_ABANDON_REFUSED");
    }
    const row = authority.db.prepare(
      `SELECT o.outbox_id,o.state,o.expires_at,o.action_request_id,o.settlement_receipt_digest,
        a.attempt_id,a.outcome,a.outcome_code,a.accepted_result_json,a.acceptance_receipt_digest
       FROM memory_outbox o JOIN memory_outbox_attempts a ON a.outbox_id=o.outbox_id
       WHERE o.outbox_id=?`,
    ).get(outboxId) as {
      state: string; expires_at: string; action_request_id: string | null; settlement_receipt_digest: string | null;
      attempt_id: string; outcome: string; outcome_code: string | null;
      accepted_result_json: string | null; acceptance_receipt_digest: string | null;
    } | undefined;
    const expired = row !== undefined && Date.parse(row.expires_at) < now.getTime();
    const proven = row?.outcome === "uncertain" && row.outcome_code !== null && PRE_DELIVERY.has(row.outcome_code)
      && row.accepted_result_json === null && row.acceptance_receipt_digest === null
      && row.settlement_receipt_digest === null && row.action_request_id !== null;
    if (row === undefined || row.state !== "reconciling" || !expired || !proven) {
      throw new JarvisError("MEMORY_OUTBOX_ABANDON_REFUSED");
    }
    const linked = authority.db.prepare(
      "SELECT state,lease_fence FROM control_command_requests WHERE request_id=?",
    ).get(row.action_request_id) as { state: string; lease_fence: number } | undefined;
    if (linked?.state !== "uncertain") throw new JarvisError("MEMORY_OUTBOX_ABANDON_REFUSED");
    const digest = `sha256:${createHash("sha256").update(canonicalize({ outbox_id: outboxId,
      attempt_id: row.attempt_id, outcome_code: row.outcome_code, closed_at: at })).digest("hex")}`;
    authority.db.prepare(
      `INSERT INTO memory_outbox_not_delivered(outbox_id,state,attempt_id,outcome_code,action_request_id,
        receipt_digest,closed_at,created_at) VALUES(?,?,?,?,?,?,?,?)`,
    ).run(outboxId, "abandoned_not_delivered", row.attempt_id, row.outcome_code, row.action_request_id,
      digest, at, at);
    authority.db.prepare(
      `INSERT INTO memory_outbox_not_delivered_events(event_id,outbox_id,event_type,outcome_code,receipt_digest,created_at)
       VALUES(?,?,?,?,?,?)`,
    ).run(`evt:${outboxId}:abandoned`, outboxId, "abandoned_not_delivered", row.outcome_code, digest, at);
    const changed = authority.db.prepare(
      `UPDATE control_command_requests SET state='failed',completed_at=?,failure_code='ABANDONED_NOT_DELIVERED',
        lease_owner=NULL,lease_expires_at=NULL WHERE request_id=? AND state='uncertain' AND lease_fence=?`,
    ).run(at, row.action_request_id, linked.lease_fence).changes;
    if (changed !== 1) throw new JarvisError("MEMORY_OUTBOX_ABANDON_REFUSED");
    return { outbox_id: outboxId, state: "abandoned_not_delivered" as const };
  }).immediate();
}

export function executeAbandonedNotDelivered(authority: AuthorityDb, control: ControlPlane,
  command: ClaimedControlCommand, requestId: string, now: Date, completedAt: Date) {
  const closed = abandonUndeliveredOutbox(authority, command, now);
  control.settle(requestId, command.fence, { state: "completed",
    effect_type: "memory.outbox.abandoned_not_delivered", payload: closed }, completedAt);
  return { request_id: requestId, action: command.action, state: "completed" as const, result: closed };
}
