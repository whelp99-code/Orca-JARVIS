import { randomBytes } from "node:crypto";
import { JarvisError } from "./db.js";
import { base64url } from "./receipt.js";
import { parseSecondBrainStrictJsonBytes } from "./second-brain-strict-json.js";
import { sha256Prefixed } from "./remote-approval-crypto.js";
import { RemoteEnrollmentStore } from "./remote-approval-enrollment-store.js";
import { RemoteApprovalError, REMOTE_ERROR_CODES } from "./remote-approval-errors.js";
import { parseAttestationCredential, parseBeginRequestBody, parseVerifyBody } from "./remote-approval-parse.js";
import type { RemoteApprovalService } from "./remote-approval.js";
import { admitRegistrationVerify, recordRegistrationRejectionAudit } from "./remote-approval-registration-rejection.js";
import type { RemoteIngressContextV1 } from "./remote-approval-types.js";
import { verifyAttestationCrypto } from "./remote-approval-webauthn.js";

function rethrow(error: unknown): never {
  if (error instanceof RemoteApprovalError) throw error;
  if (error instanceof JarvisError) {
    throw new RemoteApprovalError(REMOTE_ERROR_CODES.REMOTE_APPROVAL_NOT_APPLICABLE, error.code);
  }
  throw error;
}

function enrollments(service: RemoteApprovalService): RemoteEnrollmentStore {
  return new RemoteEnrollmentStore(service.options.db);
}

export function issueRegistrationOptions(
  service: RemoteApprovalService, enrollmentId: string, body: unknown, ingress: RemoteIngressContextV1, now: Date,
): { schema_version: 1; ceremony_id: string; options: Record<string, unknown> } {
  service.requireReady(now);
  service.requireIngress(ingress, `/api/v1/security/webauthn/registrations/${enrollmentId}/options`, "POST");
  const beginRequestId = parseBeginRequestBody(body);
  const at = now.toISOString();
  const store = enrollments(service);
  let ceremonyId = "";
  let challengeB64 = "";
  const tx = service.options.db.db.transaction(() => {
    store.expireRegistrations(at);
    const existing = store.liveRegistration(enrollmentId, ingress.gateway_session_digest);
    if (existing) {
      ceremonyId = existing.ceremony_id;
      challengeB64 = existing.challenge_b64;
      return;
    }
    const request = service.store.pendingRequest(beginRequestId);
    if (!request || String(request.action) !== "remote.credential.enroll.begin" || String(request.state) !== "approved") {
      throw new RemoteApprovalError(REMOTE_ERROR_CODES.REMOTE_APPROVAL_NOT_APPLICABLE, "begin");
    }
    const args = JSON.parse(String(request.args_json)) as { enrollment_id?: string };
    if (args.enrollment_id !== enrollmentId) throw new RemoteApprovalError(REMOTE_ERROR_CODES.REMOTE_APPROVAL_NOT_APPLICABLE, "enrollment");
    if (Date.parse(String(request.expires_at)) <= now.getTime()) throw new RemoteApprovalError(REMOTE_ERROR_CODES.REMOTE_CEREMONY_REJECTED, "expired");
    const receipt = store.approvedReceipt(beginRequestId);
    if (!receipt) throw new RemoteApprovalError(REMOTE_ERROR_CODES.REMOTE_APPROVAL_NOT_APPLICABLE, "receipt");
    if (store.countLiveRegistrations() >= service.options.policy.remote_approval.live_registration_cap) {
      throw new RemoteApprovalError(REMOTE_ERROR_CODES.REMOTE_RATE_LIMITED, "cap");
    }
    const owner = service.store.principal();
    if (!owner || owner.state !== "active") throw new RemoteApprovalError(REMOTE_ERROR_CODES.REMOTE_AUTHORITY_UNAVAILABLE, "principal");
    ceremonyId = `rgy_${randomBytes(16).toString("hex")}`;
    const nonce = randomBytes(32);
    challengeB64 = base64url(randomBytes(32));
    const expires = new Date(Math.min(
      now.getTime() + service.options.policy.remote_approval.registration_ttl_seconds * 1000,
      Date.parse(String(request.expires_at)),
      Date.parse(receipt.expires_at),
    )).toISOString();
    store.insertRegistration({
      ceremony_id: ceremonyId, enrollment_id: enrollmentId, begin_request_id: beginRequestId,
      begin_receipt_id: receipt.receipt_id, principal_id: owner.principal_id,
      user_handle_digest: owner.user_handle_digest, gateway_session_digest: ingress.gateway_session_digest,
      gateway_owner_digest: ingress.gateway_owner_digest, origin: service.options.origin, rp_id: service.options.rpId,
      challenge_b64: challengeB64, challenge_digest: sha256Prefixed(challengeB64), nonce_digest: sha256Prefixed(nonce),
      state: "issued", issued_at: at, expires_at: expires,
    });
  });
  tx.immediate();
  const owner = service.store.principal();
  if (!owner) throw new RemoteApprovalError(REMOTE_ERROR_CODES.REMOTE_AUTHORITY_UNAVAILABLE, "principal");
  return {
    schema_version: 1,
    ceremony_id: ceremonyId,
    options: {
      challenge: challengeB64,
      rp: { id: service.options.rpId, name: "JARVIS" },
      user: { id: base64url(owner.user_handle), name: "JARVIS owner", displayName: "JARVIS owner" },
      pubKeyCredParams: [{ type: "public-key", alg: -7 }, { type: "public-key", alg: -8 }],
      timeout: service.options.policy.remote_approval.registration_ttl_seconds * 1000,
      attestation: "none",
      excludeCredentials: store.liveCredentialIds().map(id => ({ type: "public-key", id })),
      authenticatorSelection: { residentKey: "required", userVerification: "required" },
    },
  };
}

export async function verifyRegistration(
  service: RemoteApprovalService, ceremonyId: string, rawBody: Buffer, ingress: RemoteIngressContextV1, now: Date,
): Promise<{ schema_version: 1; credential_id: string; activation_request_id: string }> {
  service.requireReady(now);
  service.requireIngress(ingress, `/api/v1/security/webauthn/registrations/${ceremonyId}/verify`, "POST");
  const at = now.toISOString();
  const store = enrollments(service);
  const ceremony = admitRegistrationVerify({ service, ceremonyId, ingress, now });
  service.options.db.db.transaction(() => {
    const reservedUntil = new Date(
      now.getTime() + service.options.policy.remote_approval.verification_reservation_ttl_seconds * 1000,
    ).toISOString();
    store.reserveRegistration(ceremonyId, at, reservedUntil);
  }).immediate();
  try {
    const parsed = parseSecondBrainStrictJsonBytes(rawBody);
    if (parsed === undefined) throw new RemoteApprovalError(REMOTE_ERROR_CODES.REMOTE_REQUEST_INVALID, "json");
    const attestation = parseAttestationCredential(parseVerifyBody(parsed));
    const crypto = await verifyAttestationCrypto({
      attestation, expectedChallenge: ceremony.challenge_b64,
      expectedOrigin: service.options.origin, expectedRpId: service.options.rpId,
    });
    const credentialId = crypto.credentialId;
    const publicKey = Buffer.from(crypto.publicKey);
    const digest = sha256Prefixed(Buffer.from(credentialId, "base64url"));
    const keyDigest = sha256Prefixed(publicKey);
    const backupEligible = crypto.backupEligible ? 1 : 0;
    const backupState = crypto.backupState ? 1 : 0;
    if (backupEligible === 0 && backupState === 1) {
      throw new RemoteApprovalError(REMOTE_ERROR_CODES.REMOTE_CEREMONY_REJECTED, "BACKUP_FLAGS_INVALID");
    }
    const owner = service.store.principal();
    if (!owner || owner.principal_id !== ceremony.principal_id) {
      throw new RemoteApprovalError(REMOTE_ERROR_CODES.REMOTE_CEREMONY_REJECTED, "principal");
    }
    const activateExpires = new Date(now.getTime() + service.options.policy.remote_approval.activation_ttl_seconds * 1000).toISOString();
    const activationId = `rca_${randomBytes(16).toString("hex")}`;
    const commit = service.options.db.db.transaction(() => {
      if (service.store.tombstoneMatch(digest, keyDigest) || service.store.liveCredentialDigestMatch(digest, keyDigest)) {
        throw new RemoteApprovalError(REMOTE_ERROR_CODES.REMOTE_CEREMONY_REJECTED, "duplicate");
      }
      if (store.countPendingCredentials() >= service.options.policy.remote_approval.pending_credential_cap) {
        throw new RemoteApprovalError(REMOTE_ERROR_CODES.REMOTE_RATE_LIMITED, "pending_cap");
      }
      service.options.control.stage({
        schema_version: 1, request_id: activationId, action: "remote.credential.enroll.activate", action_level: 3,
        target: {
          principal_id: owner.principal_id, credential_id_digest: digest, public_key_digest: keyDigest,
          user_handle_digest: ceremony.user_handle_digest, rp_id: service.options.rpId, origin: service.options.origin,
        },
        args: {
          schema_version: 1, enrollment_id: ceremony.enrollment_id, registration_ceremony_id: ceremony.ceremony_id,
          algorithm: crypto.algorithm, backup_eligible: backupEligible,
        },
        reversible: false, requested_by: service.options.policy.owner_principal,
        requested_at: at, expires_at: activateExpires, nonce: `nac_${randomBytes(16).toString("hex")}`,
      }, now);
      store.insertPendingCredential({
        credential_id: credentialId, credential_id_digest: digest, principal_id: owner.principal_id,
        public_key_cose: publicKey.toString("base64url"), public_key_digest: keyDigest,
        algorithm: crypto.algorithm, user_handle_digest: ceremony.user_handle_digest,
        sign_count: crypto.counter, counter_mode: crypto.counter === 0 ? "zero" : "monotonic",
        backup_eligible: backupEligible, backup_state: backupState, registration_ceremony_id: ceremony.ceremony_id,
        activation_request_id: activationId, pending_expires_at: activateExpires, created_at: at,
      });
      store.finishRegistration(ceremonyId, "consumed", "registered");
    });
    commit.immediate();
    return { schema_version: 1, credential_id: credentialId, activation_request_id: activationId };
  } catch (error) {
    const reason = error instanceof RemoteApprovalError ? error.reason : "verify";
    service.options.db.db.transaction(() => {
      store.finishRegistration(ceremonyId, "rejected", reason);
      recordRegistrationRejectionAudit({ service, ceremonyId, row: ceremony, now, outcome: "rejected", reason });
    }).immediate();
    rethrow(error);
  }
}
