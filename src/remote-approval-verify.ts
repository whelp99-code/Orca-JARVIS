import { randomBytes, timingSafeEqual } from "node:crypto";
import { canonicalize } from "./canonical.js";
import { controlActionDescriptor, validateControlAction } from "./control-actions.js";
import { parseSecondBrainStrictJsonBytes } from "./second-brain-strict-json.js";
import { evaluateBackup, evaluateCounter } from "./remote-approval-backup.js";
import { remoteReceiptId, remoteReceiptNonce, sha256Prefixed } from "./remote-approval-crypto.js";
import { RemoteApprovalError, REMOTE_ERROR_CODES } from "./remote-approval-errors.js";
import type { AuthorityDb } from "./db.js";
import type { ControlPlane } from "./control-plane.js";
import { parseAssertionCredential, parseVerifyBody } from "./remote-approval-parse.js";
import type { RemoteApprovalPolicy } from "./remote-approval-policy.js";
import type { ControlReceiptSigner } from "./remote-approval-signer.js";
import { RemoteApprovalStore, type ChallengeRow } from "./remote-approval-store.js";
import { REMOTE_ALLOWED_ACTIONS, type RemoteIngressContextV1 } from "./remote-approval-types.js";
import { recordRemoteAudit, type AuditFlags } from "./remote-approval-audit.js";
import { verifyAssertionCrypto } from "./remote-approval-webauthn.js";

export type EligibleCommand = {
  action: string;
  action_level: number;
  reversible: number;
  target: Record<string, unknown>;
  args: Record<string, unknown>;
  command_digest: `sha256:${string}`;
  target_digest: `sha256:${string}`;
  args_digest: `sha256:${string}`;
  nonce_digest: `sha256:${string}`;
  requested_at: string;
  expires_at: string;
  state: string;
};

export function loadEligibleRequest(store: RemoteApprovalStore, requestId: string, now: Date): EligibleCommand {
  const row = store.pendingRequest(requestId);
  if (!row || String(row.state) !== "pending") throw new RemoteApprovalError(REMOTE_ERROR_CODES.REMOTE_APPROVAL_NOT_APPLICABLE, "request");
  if (store.receiptCount(requestId) !== 0) throw new RemoteApprovalError(REMOTE_ERROR_CODES.REMOTE_APPROVAL_NOT_APPLICABLE, "receipt");
  if (Date.parse(String(row.expires_at)) <= now.getTime())
    throw new RemoteApprovalError(REMOTE_ERROR_CODES.REMOTE_APPROVAL_NOT_APPLICABLE, "expired");
  const target = JSON.parse(String(row.target_json)) as Record<string, unknown>;
  const args = JSON.parse(String(row.args_json)) as Record<string, unknown>;
  const action = String(row.action);
  const action_level = Number(row.action_level);
  validateControlAction({ action, action_level, target, args });
  const descriptor = controlActionDescriptor(action);
  if (!descriptor || !REMOTE_ALLOWED_ACTIONS.includes(action as (typeof REMOTE_ALLOWED_ACTIONS)[number]) || !descriptor.executable) {
    throw new RemoteApprovalError(REMOTE_ERROR_CODES.REMOTE_APPROVAL_UNAVAILABLE, "action");
  }
  if (action_level < descriptor.minimum_level || action_level > 3)
    throw new RemoteApprovalError(REMOTE_ERROR_CODES.REMOTE_APPROVAL_UNAVAILABLE, "level");
  const targetJson = canonicalize(target);
  const argsJson = canonicalize(args);
  if (Buffer.byteLength(targetJson, "utf8") + Buffer.byteLength(argsJson, "utf8") > 8192) {
    throw new RemoteApprovalError(REMOTE_ERROR_CODES.REMOTE_APPROVAL_UNAVAILABLE, "size");
  }
  return {
    action,
    action_level,
    reversible: Number(row.reversible),
    target,
    args,
    command_digest: String(row.command_digest) as `sha256:${string}`,
    target_digest: sha256Prefixed(targetJson),
    args_digest: sha256Prefixed(argsJson),
    nonce_digest: sha256Prefixed(String(row.nonce)),
    requested_at: String(row.requested_at),
    expires_at: String(row.expires_at),
    state: String(row.state),
  };
}

export type RemoteApprovalVerifyDeps = Readonly<{
  db: AuthorityDb;
  control: ControlPlane;
  origin: string;
  rpId: string;
  signer: ControlReceiptSigner;
  policy: { readonly remote_approval: RemoteApprovalPolicy };
}>;

export async function translateReservedAssertion(
  options: RemoteApprovalVerifyDeps,
  store: RemoteApprovalStore,
  challenge: ChallengeRow,
  rawBody: Buffer,
  ingress: RemoteIngressContextV1,
  now: Date,
): Promise<{ receipt_id: string; request_id: string; decision: "approve" | "reject" }> {
  const parsed = parseSecondBrainStrictJsonBytes(rawBody);
  if (parsed === undefined) throw new RemoteApprovalError(REMOTE_ERROR_CODES.REMOTE_REQUEST_INVALID, "json");
  const assertion = parseAssertionCredential(parseVerifyBody(parsed));
  const owner = store.principal();
  if (!owner || owner.state !== "active") throw new RemoteApprovalError(REMOTE_ERROR_CODES.REMOTE_CEREMONY_REJECTED, "principal");
  if (!timingSafeEqual(assertion.userHandle, owner.user_handle) || owner.principal_id !== challenge.remote_principal_id) {
    throw new RemoteApprovalError(REMOTE_ERROR_CODES.REMOTE_CEREMONY_REJECTED, "handle");
  }
  const credential = store.credential(assertion.id);
  if (!credential || credential.state !== "active" || credential.principal_id !== owner.principal_id) {
    throw new RemoteApprovalError(REMOTE_ERROR_CODES.REMOTE_CEREMONY_REJECTED, "credential");
  }
  const crypto = await verifyAssertionCrypto({
    assertion,
    expectedChallenge: challenge.challenge_b64,
    expectedOrigin: options.origin,
    expectedRpId: options.rpId,
    credentialId: credential.credential_id,
    publicKey: Buffer.from(credential.public_key_cose, "base64url"),
    counter: credential.sign_count,
  });
  const flags = assertion.authenticatorData[32] ?? 0;
  const auditFlags: AuditFlags = { up: (flags & 0x01) === 0 ? 0 : 1, uv: (flags & 0x04) === 0 ? 0 : 1 };
  const returnedBackup = { eligible: ((flags & 0x08) !== 0 ? 1 : 0) as 0 | 1, state: ((flags & 0x10) !== 0 ? 1 : 0) as 0 | 1 };
  const backup = evaluateBackup({ eligible: credential.backup_eligible as 0 | 1, state: credential.backup_state as 0 | 1 }, returnedBackup);
  if (backup.kind === "reject") throw new RemoteApprovalError(REMOTE_ERROR_CODES.REMOTE_CEREMONY_REJECTED, backup.reason);
  const counter = evaluateCounter(credential.sign_count, crypto.newCounter);
  if (counter.kind === "reject") {
    store.insertCounterSignal({
      credential_digest: credential.credential_id_digest,
      challenge_id: challenge.challenge_id,
      assertion_digest: sha256Prefixed(assertion.signature),
      stored_count: credential.sign_count,
      returned_count: crypto.newCounter,
      reason: "counter_nonincreasing",
      observed_at: now.toISOString(),
    });
    throw new RemoteApprovalError(REMOTE_ERROR_CODES.REMOTE_CEREMONY_REJECTED, "counter_nonincreasing");
  }
  const request = loadEligibleRequest(store, challenge.request_id, now);
  if (
    request.command_digest !== challenge.command_digest ||
    request.action !== challenge.action ||
    request.target_digest !== challenge.target_digest ||
    request.args_digest !== challenge.args_digest
  ) {
    throw new RemoteApprovalError(REMOTE_ERROR_CODES.REMOTE_CEREMONY_REJECTED, "binding");
  }
  const assertionId = `ras_${randomBytes(16).toString("hex")}`;
  const assertionDigest = sha256Prefixed(
    Buffer.concat([assertion.rawId, assertion.clientDataJSON, assertion.authenticatorData, assertion.signature]),
  );
  const expires = new Date(Math.min(
    now.getTime() + options.policy.remote_approval.challenge_ttl_seconds * 1000,
    Date.parse(challenge.expires_at),
    Date.parse(request.expires_at),
  )).toISOString();
  if (Date.parse(expires) <= now.getTime()) throw new RemoteApprovalError(REMOTE_ERROR_CODES.REMOTE_CEREMONY_REJECTED, "receipt_expiry");
  const receiptId = remoteReceiptId({
    assertion_digest: assertionDigest,
    challenge_id: challenge.challenge_id,
    decision: challenge.decision,
    request_id: challenge.request_id,
    schema_version: 1,
  });
  const nonce = remoteReceiptNonce({
    assertion_digest: assertionDigest,
    challenge_nonce_digest: sha256Prefixed(challenge.challenge_nonce),
    request_id: challenge.request_id,
    schema_version: 1,
  });
  const issued = now.toISOString();
  const receipt = options.signer.signVerifiedRemoteDecision({
    schema_version: 1,
    receipt_id: receiptId,
    request_id: challenge.request_id,
    decision: challenge.decision,
    command_digest: challenge.command_digest,
    signer_principal_id: options.signer.principalId,
    authenticated_session_id: `webauthn-assertion:${assertionId}`,
    key_id: options.signer.keyId,
    algorithm: "Ed25519",
    issued_at: issued,
    not_before: issued,
    expires_at: expires,
    nonce,
    max_uses: 1,
    status: "issued",
  });
  const tx = options.db.db.transaction(() => {
    const live = store.challenge(challenge.challenge_id);
    if (!live || live.state !== "verifying") throw new RemoteApprovalError(REMOTE_ERROR_CODES.REMOTE_APPROVAL_NOT_APPLICABLE, "lost");
    store.insertAssertion({
      assertion_id: assertionId,
      challenge_id: challenge.challenge_id,
      request_id: challenge.request_id,
      credential_id: credential.credential_id,
      principal_id: owner.principal_id,
      gateway_session_digest: ingress.gateway_session_digest,
      decision: challenge.decision,
      assertion_digest: assertionDigest,
      client_digest: sha256Prefixed(assertion.clientDataJSON),
      authenticator_digest: sha256Prefixed(assertion.authenticatorData),
      signature_digest: sha256Prefixed(assertion.signature),
      handle_digest: sha256Prefixed(assertion.userHandle),
      sign_count: counter.next,
      backup_eligible: backup.next.eligible,
      backup_state: backup.next.state,
      origin: options.origin,
      rp_id: options.rpId,
      asserted_at: issued,
    });
    store.updateCounter(credential.credential_id, counter.next, counter.mode, backup.next.state);
    options.control.decide(receipt, now);
    store.insertTranslation({
      translation_id: `trt_${assertionId}`,
      assertion_id: assertionId,
      challenge_id: challenge.challenge_id,
      request_id: challenge.request_id,
      receipt_id: receiptId,
      binding_digest: challenge.binding_digest,
      translated_at: issued,
    });
    store.finishChallenge(challenge.challenge_id, "consumed", "translated");
    recordRemoteAudit(store, challenge, now, "translated", "translated", credential, counter.disposition, assertionDigest, auditFlags, "");
  });
  tx.immediate();
  return { receipt_id: receiptId, request_id: challenge.request_id, decision: challenge.decision };
}

