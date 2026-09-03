import {
  CLIENT_KINDS,
  REMOTE_APPROVAL_STATES,
  REMOTE_CHALLENGE_STATES,
  REMOTE_DECISIONS,
  REMOTE_PRINCIPAL_STATES,
  type RemoteApprovalPayloadV1,
  type RemoteApprovalReceiptId,
  type RemoteApprovalReceiptV1,
  type RemoteChallengeId,
  type RemoteChallengePayloadV1,
  type RemoteChallengeV1,
  type RemotePrincipalId,
  type RemotePrincipalPayloadV1,
  type RemotePrincipalV1,
} from "./personal-contracts.js";
import {
  invalid,
  record,
  closed,
  literal,
  text,
  integer,
  booleanTrue,
  digest,
  prefixedId,
  list,
  type ParsedBase,
  type IdParser,
} from "./personal-validation-primitives.js";
import { bindApproval, parseOwnerReceipt, parseRemoteVerification, parseRemoteTranslation } from "./personal-validation-receipts.js";
import { parseBase, finish, common } from "./personal-validation-base.js";

export function parseRemotePrincipalV1(value: unknown): RemotePrincipalV1 {
  const { input, base } = parseBase(value, (item) => prefixedId<RemotePrincipalId>(item, "rpr:pos:v1:"));
  const p = record(input.payload);
  closed(p, ["subject", "client_kinds", "credential_id", "public_key_digest", "sign_count", "state"]);
  const payload: RemotePrincipalPayloadV1 = {
    subject: text(p.subject, 128),
    client_kinds: list(p.client_kinds, (item) => literal(item, CLIENT_KINDS)),
    credential_id: text(p.credential_id, 512),
    public_key_digest: digest(p.public_key_digest),
    sign_count: integer(p.sign_count, 0, Number.MAX_SAFE_INTEGER),
    state: literal(p.state, REMOTE_PRINCIPAL_STATES),
  };
  if (payload.state === "absent") {
    if (input.receipt !== null || base.authority.authority_kind !== "none") invalid();
    return finish(common(base, payload, null));
  }
  if (input.receipt === null) invalid();
  const receipt = parseOwnerReceipt(input.receipt, base);
  const expectedKind = payload.state === "active" ? "owner_enrollment" : "owner_revocation";
  if (
    receipt.receipt_kind !== expectedKind ||
    receipt.credential_id !== payload.credential_id ||
    receipt.public_key_digest !== payload.public_key_digest ||
    receipt.approval.signer_principal_id !== payload.subject ||
    receipt.approval.decision !== "approve"
  )
    invalid();
  bindApproval(base, receipt.approval, payload.public_key_digest);
  return finish(common(base, payload, receipt));
}
function parseGatewayBase<Id>(value: unknown, parseId: IdParser<Id>): { readonly input: Record<string, unknown>; readonly base: ParsedBase<Id> } {
  const parsed = parseBase(value, parseId);
  if (parsed.base.source.source_kind !== "gateway" || !parsed.base.source.source_id.startsWith("src:pos:v1:gateway:")) invalid();
  return parsed;
}
export function parseRemoteChallengeV1(value: unknown): RemoteChallengeV1 {
  const { input, base } = parseGatewayBase(value, (item) => prefixedId<RemoteChallengeId>(item, "rch:pos:v1:"));
  const p = record(input.payload);
  closed(p, ["principal_id", "session_id", "command_digest", "target_digest", "args_digest", "nonce", "origin", "rp_id", "state"]);
  const origin = text(p.origin, 512);
  const rp = text(p.rp_id, 253);
  if (origin !== `https://${rp}` || rp.includes(":") || rp.includes("/") || rp.startsWith(".") || rp.endsWith(".")) invalid();
  const payload: RemoteChallengePayloadV1 = {
    principal_id: prefixedId<RemotePrincipalId>(p.principal_id, "rpr:pos:v1:"),
    session_id: text(p.session_id, 128),
    command_digest: digest(p.command_digest),
    target_digest: digest(p.target_digest),
    args_digest: digest(p.args_digest),
    nonce: text(p.nonce, 256),
    origin,
    rp_id: rp,
    state: literal(p.state, REMOTE_CHALLENGE_STATES),
  };
  if (input.receipt !== null) invalid();
  return finish(common(base, payload, null));
}
export function parseRemoteApprovalReceiptV1(value: unknown): RemoteApprovalReceiptV1 {
  const { input, base } = parseGatewayBase(value, (item) => prefixedId<RemoteApprovalReceiptId>(item, "rap:pos:v1:"));
  const p = record(input.payload);
  closed(p, [
    "challenge_id",
    "principal_id",
    "session_id",
    "credential_id",
    "assertion_digest",
    "command_digest",
    "target_digest",
    "args_digest",
    "decision",
    "single_use",
    "state",
  ]);
  const payload: RemoteApprovalPayloadV1 = {
    challenge_id: prefixedId<RemoteChallengeId>(p.challenge_id, "rch:pos:v1:"),
    principal_id: prefixedId<RemotePrincipalId>(p.principal_id, "rpr:pos:v1:"),
    session_id: text(p.session_id, 128),
    credential_id: text(p.credential_id, 512),
    assertion_digest: digest(p.assertion_digest),
    command_digest: digest(p.command_digest),
    target_digest: digest(p.target_digest),
    args_digest: digest(p.args_digest),
    decision: literal(p.decision, REMOTE_DECISIONS),
    single_use: booleanTrue(p.single_use),
    state: literal(p.state, REMOTE_APPROVAL_STATES),
  };
  if (input.receipt === null) invalid();
  if (payload.state !== "translated") {
    const receipt = parseRemoteVerification(input.receipt, base);
    if (
      base.authority.authority_kind !== "none" ||
      receipt.challenge_id !== payload.challenge_id ||
      receipt.principal_id !== payload.principal_id ||
      receipt.session_id !== payload.session_id ||
      receipt.credential_id !== payload.credential_id ||
      receipt.assertion_digest !== payload.assertion_digest ||
      receipt.command_digest !== payload.command_digest ||
      receipt.target_digest !== payload.target_digest ||
      receipt.args_digest !== payload.args_digest ||
      receipt.decision !== payload.decision ||
      (payload.state === "verified" ? receipt.result !== "verified" : receipt.result !== "rejected" || payload.decision !== "reject")
    )
      invalid();
    return finish(common(base, payload, receipt));
  }
  const receipt = parseRemoteTranslation(input.receipt, base);
  if (
    receipt.challenge_id !== payload.challenge_id ||
    receipt.principal_id !== payload.principal_id ||
    receipt.session_id !== payload.session_id ||
    receipt.credential_id !== payload.credential_id ||
    receipt.assertion_digest !== payload.assertion_digest ||
    receipt.command_digest !== payload.command_digest ||
    receipt.target_digest !== payload.target_digest ||
    receipt.args_digest !== payload.args_digest ||
    receipt.decision !== payload.decision ||
    receipt.approval.authenticated_session_id !== payload.session_id ||
    receipt.approval.decision !== payload.decision
  )
    invalid();
  bindApproval(base, receipt.approval, payload.command_digest);
  return finish(common(base, payload, receipt));
}
