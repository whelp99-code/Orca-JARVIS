import { createHash, randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { canonicalize } from "./canonical.js";
import { ControlPlane } from "./control-plane.js";
import { verifyCommandApproval, type CommandApprovalReceipt } from "./control-plane-contract.js";
import { JarvisError, type AuthorityDb } from "./db.js";
import { prepareMemoryRememberDispatch } from "./memory-remember-dispatch.js";
import { memoryCandidateSpoolRootsOf } from "./memory-surface-authority.js";
import type { ControlReceiptSigner } from "./remote-approval-signer.js";

const DIGEST = /^sha256:[0-9a-f]{64}$/;

export type ConfirmCarry =
  | { readonly carried: false; readonly reason: "not_applicable" | "sensitive" }
  | { readonly carried: true; readonly request_id: string };

type Binding = {
  readonly confirm_request_id: string;
  readonly confirm_receipt_id: string;
  readonly confirm_command_digest: string;
  readonly approved_candidate_digest: string;
};

/** One owner approval of a non-sensitive remember carries the dispatch.
 * The dispatch command digest commits to that receipt and candidate digest. */
export function carryNonSensitiveConfirm(input: {
  readonly authority: AuthorityDb;
  readonly requestId: string;
  readonly now: Date;
  readonly signer: ControlReceiptSigner;
}): ConfirmCarry {
  const command = new ControlPlane(input.authority).get(input.requestId);
  if (command?.action !== "memory.confirm" || command.state !== "approved"
    || command.args.operation !== "remember" || command.args.decision !== "confirm") {
    return { carried: false, reason: "not_applicable" };
  }
  const candidateId = String(command.target.candidate_id ?? "");
  const candidateDigest = String(command.target.candidate_digest ?? "");
  const classificationDigest = String(command.target.classification_digest ?? "");
  const row = input.authority.db.prepare(
    `SELECT m.policy_sensitivity AS sensitivity FROM memory_candidates c
     JOIN memory_candidate_classifications m ON m.candidate_id=c.candidate_id
     WHERE c.candidate_id=? AND m.candidate_digest=? AND m.classification_digest=?`,
  ).get(candidateId, candidateDigest, classificationDigest) as { sensitivity: string } | undefined;
  if (row === undefined) return { carried: false, reason: "not_applicable" };
  if (row.sensitivity === "sensitive" || row.sensitivity === "restricted") {
    return { carried: false, reason: "sensitive" };
  }
  const receipt = input.authority.db.prepare(
    `SELECT payload_json, signature FROM control_command_receipts
     WHERE request_id=? AND decision='approve' AND command_digest=?`,
  ).get(input.requestId, command.command_digest) as { payload_json: string; signature: string } | undefined;
  if (receipt === undefined) return { carried: false, reason: "not_applicable" };
  const parsed = JSON.parse(receipt.payload_json) as CommandApprovalReceipt;
  if (parsed.signature !== receipt.signature || parsed.command_digest !== command.command_digest) {
    throw new JarvisError("MEMORY_OUTBOX_AUTHORITY_INVALID");
  }
  const binding: Binding = {
    confirm_request_id: input.requestId,
    confirm_receipt_id: parsed.receipt_id,
    confirm_command_digest: command.command_digest,
    approved_candidate_digest: candidateDigest,
  };
  const registered = memoryCandidateSpoolRootsOf(input.authority);
  const root = dirname(resolve(input.authority.filename));
  const roots = {
    candidate_review_spool_root: registered?.review_root
      ?? process.env.JARVIS_MEMORY_REVIEW_SPOOL_ROOT ?? join(root, "memory-review-spool"),
    candidate_dispatch_spool_root: registered?.dispatch_root
      ?? process.env.JARVIS_MEMORY_DISPATCH_SPOOL_ROOT ?? join(root, "memory-dispatch-spool"),
  };
  const prepared = prepareMemoryRememberDispatch(input.authority, candidateId, input.now, roots);
  if (prepared.target.candidate_digest !== candidateDigest
    || prepared.target.classification_digest !== classificationDigest) {
    throw new JarvisError("MEMORY_OUTBOX_AUTHORITY_INVALID");
  }
  const stagedInput = {
    ...prepared,
    args: { ...prepared.args, confirm_binding: binding },
  };
  const identity = createHash("sha256").update("orca-jarvis/memory-confirm-carry/v1\0")
    .update(canonicalize(stagedInput)).digest("hex");
  const requestId = `memory-dispatch:${identity}`;
  const control = new ControlPlane(input.authority);
  const expires = new Date(Math.min(Date.parse(prepared.expires_at), Date.parse(command.expires_at),
    input.now.getTime() + 15 * 60_000)).toISOString();
  const prior = control.get(requestId);
  if (prior !== undefined && (canonicalize(prior.args) !== canonicalize(stagedInput.args)
    || canonicalize(prior.target) !== canonicalize(stagedInput.target))) {
    throw new JarvisError("MEMORY_OUTBOX_AUTHORITY_INVALID");
  }
  const staged = prior ?? control.stage({
    ...stagedInput, schema_version: 1, request_id: requestId, requested_by: "principal:owner",
    requested_at: input.now.toISOString(), expires_at: expires, nonce: requestId,
  }, input.now);
  if (staged.state !== "pending") return { carried: true, request_id: requestId };
  const issued = input.now.toISOString();
  const signed = input.signer.signVerifiedRemoteDecision({
    schema_version: 1,
    receipt_id: `rcpt:carry:${randomUUID()}`,
    request_id: requestId,
    decision: "approve",
    command_digest: staged.command_digest,
    signer_principal_id: input.signer.principalId,
    authenticated_session_id: parsed.authenticated_session_id,
    key_id: input.signer.keyId,
    algorithm: "Ed25519",
    issued_at: issued,
    not_before: issued,
    expires_at: expires,
    nonce: `carry:${randomUUID()}`,
    max_uses: 1,
    status: "issued",
  });
  control.decide(signed, input.now);
  return { carried: true, request_id: requestId };
}

/** The carried dispatch may run only while it still names the approved digest. */
export function assertCarriedConfirmBinding(authority: AuthorityDb, args: Readonly<Record<string, unknown>>,
  targetDigest: string, now: Date): void {
  const binding = args.confirm_binding;
  if (binding === undefined) return;
  if (typeof binding !== "object" || binding === null || Array.isArray(binding)) {
    throw new JarvisError("MEMORY_OUTBOX_AUTHORITY_INVALID");
  }
  const record = binding as Record<string, unknown>;
  const confirmRequest = stringField(record, "confirm_request_id");
  const confirmReceipt = stringField(record, "confirm_receipt_id");
  const confirmDigest = stringField(record, "confirm_command_digest");
  const approvedDigest = stringField(record, "approved_candidate_digest");
  if (!DIGEST.test(confirmDigest) || !DIGEST.test(approvedDigest) || approvedDigest !== targetDigest) {
    throw new JarvisError("MEMORY_OUTBOX_AUTHORITY_INVALID");
  }
  const stored = authority.db.prepare(
    `SELECT payload_json, signature, k.public_key_pem FROM control_command_receipts a
     JOIN trusted_authority_keys k ON k.key_id=a.key_id
     JOIN authority_key_purposes p ON p.key_id=k.key_id AND p.purpose='decision'
     WHERE a.receipt_id=? AND a.request_id=? AND a.decision='approve'`,
  ).get(confirmReceipt, confirmRequest) as { payload_json: string; signature: string; public_key_pem: string } | undefined;
  if (stored === undefined) throw new JarvisError("MEMORY_OUTBOX_AUTHORITY_INVALID");
  const receipt = JSON.parse(stored.payload_json) as CommandApprovalReceipt;
  const issued = new Date(receipt.issued_at);
  if (receipt.signature !== stored.signature || receipt.command_digest !== confirmDigest
    || receipt.decision !== "approve" || !verifyCommandApproval(receipt, stored.public_key_pem, issued)) {
    throw new JarvisError("MEMORY_OUTBOX_AUTHORITY_INVALID");
  }
  const confirm = new ControlPlane(authority).get(confirmRequest);
  if (confirm?.command_digest !== confirmDigest || confirm.action !== "memory.confirm"
    || String(confirm.target.candidate_digest) !== approvedDigest) {
    throw new JarvisError("MEMORY_OUTBOX_AUTHORITY_INVALID");
  }
  if (Date.parse(receipt.expires_at) <= now.getTime() && confirm.state === "approved") {
    // A still-open confirm whose receipt has lapsed cannot mint a new write.
    throw new JarvisError("MEMORY_OUTBOX_AUTHORITY_INVALID");
  }
}

function stringField(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) throw new JarvisError("MEMORY_OUTBOX_AUTHORITY_INVALID");
  return value;
}
