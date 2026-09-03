import type { CommandApprovalReceipt } from "./control-plane.js";
import {
  REMOTE_DECISIONS,
  type ConfirmationReceiptV1,
  type DeliveryReceiptV1,
  type OwnerAuthorityReceiptV1,
  type RemoteChallengeId,
  type RemotePrincipalId,
  type RemoteTranslationReceiptV1,
  type RemoteVerificationReceiptV1,
  type Sha256Digest,
  type UtcTimestamp,
} from "./personal-contracts.js";
import {
  invalid,
  record,
  closed,
  literal,
  text,
  integer,
  digest,
  timestamp,
  nullableTimestamp,
  prefixedId,
  type ParsedBase,
} from "./personal-validation-primitives.js";

export function parseCommandReceipt(value: unknown, createdAt: UtcTimestamp, envelopeExpires: UtcTimestamp): CommandApprovalReceipt {
  const input = record(value);
  closed(input, [
    "schema_version",
    "receipt_id",
    "request_id",
    "decision",
    "command_digest",
    "signer_principal_id",
    "authenticated_session_id",
    "key_id",
    "algorithm",
    "issued_at",
    "not_before",
    "expires_at",
    "nonce",
    "max_uses",
    "status",
    "signature",
  ]);
  if (input.schema_version !== 1 || input.algorithm !== "Ed25519" || input.max_uses !== 1 || input.status !== "issued") invalid();
  const issued = timestamp(input.issued_at);
  const notBefore = timestamp(input.not_before);
  const expires = timestamp(input.expires_at);
  const created = Date.parse(createdAt);
  if (
    Date.parse(issued) > created ||
    Date.parse(notBefore) > created ||
    Date.parse(expires) <= created ||
    Date.parse(expires) > Date.parse(envelopeExpires) ||
    Date.parse(expires) - Date.parse(issued) > 15 * 60_000
  )
    invalid();
  return {
    schema_version: 1,
    receipt_id: text(input.receipt_id, 128),
    request_id: text(input.request_id, 128),
    decision: literal(input.decision, REMOTE_DECISIONS),
    command_digest: digest(input.command_digest),
    signer_principal_id: text(input.signer_principal_id, 128),
    authenticated_session_id: text(input.authenticated_session_id, 128),
    key_id: text(input.key_id, 128),
    algorithm: "Ed25519",
    issued_at: issued,
    not_before: notBefore,
    expires_at: expires,
    nonce: text(input.nonce, 256),
    max_uses: 1,
    status: "issued",
    signature: text(input.signature, 512),
  };
}
export function bindApproval(base: ParsedBase<unknown>, approval: CommandApprovalReceipt, commandDigest: Sha256Digest): void {
  const authority = base.authority;
  if (
    authority.authority_kind !== "control_receipt" ||
    authority.principal_id !== approval.signer_principal_id ||
    authority.request_id !== approval.request_id ||
    authority.receipt_id !== approval.receipt_id ||
    approval.command_digest !== commandDigest
  )
    invalid();
}
export function parseConfirmationReceipt(value: unknown, base: ParsedBase<unknown>): ConfirmationReceiptV1 {
  const input = record(value);
  closed(input, ["receipt_kind", "candidate_digest", "approval"]);
  if (input.receipt_kind !== "confirmation") invalid();
  return {
    receipt_kind: "confirmation",
    candidate_digest: digest(input.candidate_digest),
    approval: parseCommandReceipt(input.approval, base.created_at, base.expires_at),
  };
}
export function parseDeliveryReceipt(value: unknown, base: ParsedBase<unknown>): DeliveryReceiptV1 {
  const input = record(value);
  closed(input, [
    "receipt_kind",
    "candidate_digest",
    "attempt",
    "fence",
    "invocation_digest",
    "artifact_digest",
    "accepted_at",
    "reconciled_at",
    "approval",
  ]);
  if (input.receipt_kind !== "delivery") invalid();
  const accepted = timestamp(input.accepted_at);
  const reconciled = nullableTimestamp(input.reconciled_at);
  if (
    Date.parse(accepted) > Date.parse(base.created_at) ||
    (reconciled !== null && (Date.parse(reconciled) < Date.parse(accepted) || Date.parse(reconciled) > Date.parse(base.created_at)))
  )
    invalid();
  return {
    receipt_kind: "delivery",
    candidate_digest: digest(input.candidate_digest),
    attempt: integer(input.attempt, 1, 1_000_000),
    fence: integer(input.fence, 1, 2_147_483_647),
    invocation_digest: digest(input.invocation_digest),
    artifact_digest: digest(input.artifact_digest),
    accepted_at: accepted,
    reconciled_at: reconciled,
    approval: parseCommandReceipt(input.approval, base.created_at, base.expires_at),
  };
}
export function parseOwnerReceipt(value: unknown, base: ParsedBase<unknown>): OwnerAuthorityReceiptV1 {
  const input = record(value);
  closed(input, ["receipt_kind", "credential_id", "public_key_digest", "approval"]);
  const kind = literal(input.receipt_kind, ["owner_enrollment", "owner_revocation"] as const);
  return {
    receipt_kind: kind,
    credential_id: text(input.credential_id, 512),
    public_key_digest: digest(input.public_key_digest),
    approval: parseCommandReceipt(input.approval, base.created_at, base.expires_at),
  };
}
export function parseRemoteVerification(value: unknown, base: ParsedBase<unknown>): RemoteVerificationReceiptV1 {
  const input = record(value);
  closed(input, [
    "receipt_kind",
    "challenge_id",
    "principal_id",
    "session_id",
    "credential_id",
    "assertion_digest",
    "command_digest",
    "target_digest",
    "args_digest",
    "decision",
    "expires_at",
    "result",
  ]);
  if (input.receipt_kind !== "remote_verification") invalid();
  const expires = timestamp(input.expires_at);
  if (expires !== base.expires_at) invalid();
  return {
    receipt_kind: "remote_verification",
    challenge_id: prefixedId<RemoteChallengeId>(input.challenge_id, "rch:pos:v1:"),
    principal_id: prefixedId<RemotePrincipalId>(input.principal_id, "rpr:pos:v1:"),
    session_id: text(input.session_id, 128),
    credential_id: text(input.credential_id, 512),
    assertion_digest: digest(input.assertion_digest),
    command_digest: digest(input.command_digest),
    target_digest: digest(input.target_digest),
    args_digest: digest(input.args_digest),
    decision: literal(input.decision, REMOTE_DECISIONS),
    expires_at: expires,
    result: literal(input.result, ["verified", "rejected"] as const),
  };
}
export function parseRemoteTranslation(value: unknown, base: ParsedBase<unknown>): RemoteTranslationReceiptV1 {
  const input = record(value);
  closed(input, [
    "receipt_kind",
    "challenge_id",
    "principal_id",
    "session_id",
    "credential_id",
    "assertion_digest",
    "command_digest",
    "target_digest",
    "args_digest",
    "decision",
    "expires_at",
    "approval",
  ]);
  if (input.receipt_kind !== "control_translation") invalid();
  const expires = timestamp(input.expires_at);
  if (expires !== base.expires_at) invalid();
  return {
    receipt_kind: "control_translation",
    challenge_id: prefixedId<RemoteChallengeId>(input.challenge_id, "rch:pos:v1:"),
    principal_id: prefixedId<RemotePrincipalId>(input.principal_id, "rpr:pos:v1:"),
    session_id: text(input.session_id, 128),
    credential_id: text(input.credential_id, 512),
    assertion_digest: digest(input.assertion_digest),
    command_digest: digest(input.command_digest),
    target_digest: digest(input.target_digest),
    args_digest: digest(input.args_digest),
    decision: literal(input.decision, REMOTE_DECISIONS),
    expires_at: expires,
    approval: parseCommandReceipt(input.approval, base.created_at, base.expires_at),
  };
}
