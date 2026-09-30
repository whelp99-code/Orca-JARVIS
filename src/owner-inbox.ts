import { randomUUID } from "node:crypto";
import { ControlPlane, type CommandApprovalReceipt } from "./control-plane.js";
import { JarvisError, type AuthorityDb } from "./db.js";
import type { ControlReceiptSigner } from "./remote-approval-signer.js";

/** Actions the owner inbox may sign. Anything else stays on its existing ceremony. */
export const OWNER_INBOX_ACTIONS = [
  "memory.confirm",
  "memory.outbox.dispatch",
  "memory.outbox.abandon-not-delivered",
] as const;

export type OwnerInboxAction = (typeof OWNER_INBOX_ACTIONS)[number];
export type OwnerInboxDecision = "approve" | "reject";

export type OwnerInboxItem = Readonly<{
  request_id: string;
  action: OwnerInboxAction;
  summary: string;
  command_digest: string;
  expires_at: string;
  requested_at: string;
}>;

const ACTION_SUMMARY: Readonly<Record<OwnerInboxAction, string>> = {
  "memory.confirm": "기억 확인을 승인합니다",
  "memory.outbox.dispatch": "기억을 보내도록 승인합니다",
  "memory.outbox.abandon-not-delivered": "전달되지 않은 기억을 닫도록 승인합니다",
};

type Row = Readonly<{
  request_id: string;
  action: string;
  command_digest: string;
  expires_at: string;
  requested_at: string;
  state: string;
}>;

export class OwnerInbox {
  constructor(
    private readonly db: AuthorityDb,
    private readonly signer: ControlReceiptSigner,
    private readonly signerReady: boolean,
    private readonly now: () => Date = () => new Date(),
  ) {}

  list(): readonly OwnerInboxItem[] {
    const now = this.now().getTime();
    const rows = this.db.db.prepare(
      `SELECT request_id, action, command_digest, expires_at, requested_at, state
       FROM control_command_requests
       WHERE state = 'pending'
       ORDER BY requested_at, request_id`,
    ).all() as Row[];
    return rows.filter(row => isAllowed(row.action) && Date.parse(row.expires_at) > now).map(itemOf);
  }

  decide(input: Readonly<{
    request_id: string;
    decision: OwnerInboxDecision;
    command_digest: string;
    session_id: string;
  }>): { readonly request_id: string; readonly state: "approved" | "rejected" } {
    if (!this.signerReady) throw new JarvisError("OWNER_INBOX_UNCONFIGURED");
    if (input.session_id.length === 0) throw new JarvisError("OWNER_INBOX_IDENTITY_REQUIRED");
    if (input.decision !== "approve" && input.decision !== "reject") throw new JarvisError("OWNER_INBOX_INVALID");
    const row = this.one(input.request_id);
    if (!isAllowed(row.action)) throw new JarvisError("OWNER_INBOX_ACTION_FORBIDDEN");
    if (row.state !== "pending") throw new JarvisError("OWNER_INBOX_NOT_PENDING");
    if (row.command_digest !== input.command_digest) throw new JarvisError("OWNER_INBOX_DIGEST_MISMATCH");
    const now = this.now();
    if (Date.parse(row.expires_at) <= now.getTime()) throw new JarvisError("OWNER_INBOX_EXPIRED");
    const issued = now.toISOString();
    const receiptExpires = new Date(Math.min(Date.parse(row.expires_at), now.getTime() + 10 * 60_000)).toISOString();
    const receipt: Omit<CommandApprovalReceipt, "signature"> = {
      schema_version: 1,
      receipt_id: `rcpt:${randomUUID()}`,
      request_id: row.request_id,
      decision: input.decision,
      command_digest: row.command_digest,
      signer_principal_id: this.signer.principalId,
      authenticated_session_id: input.session_id,
      key_id: this.signer.keyId,
      algorithm: "Ed25519",
      issued_at: issued,
      not_before: issued,
      expires_at: receiptExpires,
      nonce: `inbox:${randomUUID()}`,
      max_uses: 1,
      status: "issued",
    };
    const signed = this.signer.signVerifiedRemoteDecision(receipt);
    new ControlPlane(this.db).decide(signed, now);
    this.db.db.prepare(
      "INSERT INTO audit_facts(fact_type,subject_id,payload_json,created_at) VALUES(?,?,?,?)",
    ).run(
      "owner_inbox_decision",
      row.request_id,
      JSON.stringify({
        decision: input.decision,
        command_digest: row.command_digest,
        session_id: input.session_id,
        key_id: this.signer.keyId,
      }),
      issued,
    );
    return { request_id: row.request_id, state: input.decision === "approve" ? "approved" : "rejected" };
  }

  private one(requestId: string): Row {
    const row = this.db.db.prepare(
      `SELECT request_id, action, command_digest, expires_at, requested_at, state
       FROM control_command_requests WHERE request_id = ?`,
    ).get(requestId) as Row | undefined;
    if (row === undefined) throw new JarvisError("OWNER_INBOX_NOT_FOUND");
    return row;
  }
}

function isAllowed(action: string): action is OwnerInboxAction {
  return (OWNER_INBOX_ACTIONS as readonly string[]).includes(action);
}

function itemOf(row: Row): OwnerInboxItem {
  const action = row.action as OwnerInboxAction;
  return {
    request_id: row.request_id,
    action,
    summary: ACTION_SUMMARY[action],
    command_digest: row.command_digest,
    expires_at: row.expires_at,
    requested_at: row.requested_at,
  };
}
