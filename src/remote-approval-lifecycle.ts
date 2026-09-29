import { randomBytes } from "node:crypto";
import { JarvisError } from "./db.js";
import type { CommandApprovalReceipt } from "./control-plane.js";
import { sha256Prefixed } from "./remote-approval-crypto.js";
import { RemoteEnrollmentStore } from "./remote-approval-enrollment-store.js";
import { RemoteApprovalError, REMOTE_ERROR_CODES } from "./remote-approval-errors.js";
import type { RemoteApprovalService } from "./remote-approval.js";

function iso(now: Date): string { return now.toISOString(); }
function plus(now: Date, seconds: number): string { return new Date(now.getTime() + seconds * 1000).toISOString(); }

function rethrow(error: unknown): never {
  if (error instanceof RemoteApprovalError) throw error;
  if (error instanceof JarvisError) {
    throw new RemoteApprovalError(REMOTE_ERROR_CODES.REMOTE_APPROVAL_NOT_APPLICABLE, error.code);
  }
  throw error;
}

function requireQuarantineClear(service: RemoteApprovalService): void {
  const counts = service.store.quarantineCounts();
  if (counts.remote_principals_count + counts.webauthn_credentials_count + counts.webauthn_challenges_count + counts.webauthn_assertions_count !== 0) {
    throw new RemoteApprovalError(REMOTE_ERROR_CODES.REMOTE_AUTHORITY_UNAVAILABLE, "legacy_quarantine");
  }
}

function enrollments(service: RemoteApprovalService): RemoteEnrollmentStore {
  return new RemoteEnrollmentStore(service.options.db);
}

export function beginEnrollment(service: RemoteApprovalService, now: Date): { schema_version: 1; enrollment_id: string; request_id: string } {
  requireQuarantineClear(service);
  const owner = service.ensureOwner(now);
  const enrollmentId = `ren_${randomBytes(16).toString("hex")}`;
  const requestId = `rcb_${randomBytes(16).toString("hex")}`;
  try {
    service.options.control.stage({
      schema_version: 1,
      request_id: requestId,
      action: "remote.credential.enroll.begin",
      action_level: 3,
      target: {
        principal_id: owner.principal_id,
        user_handle_digest: owner.user_handle_digest,
        rp_id: service.options.rpId,
        origin: service.options.origin,
      },
      args: {
        schema_version: 1,
        enrollment_id: enrollmentId,
        enrollment_nonce_digest: sha256Prefixed(randomBytes(32)),
      },
      reversible: false,
      requested_by: service.options.policy.owner_principal,
      requested_at: iso(now),
      expires_at: plus(now, service.options.policy.remote_approval.begin_ttl_seconds),
      nonce: `nbn_${randomBytes(16).toString("hex")}`,
    }, now);
  } catch (error) {
    rethrow(error);
  }
  return { schema_version: 1, enrollment_id: enrollmentId, request_id: requestId };
}

export function activateCredential(
  service: RemoteApprovalService, credentialId: string, receipt: CommandApprovalReceipt, now: Date,
): { schema_version: 1; credential_id: string; state: "active" } {
  requireQuarantineClear(service);
  const credential = service.store.credential(credentialId);
  if (!credential || credential.state !== "pending") {
    throw new RemoteApprovalError(REMOTE_ERROR_CODES.REMOTE_APPROVAL_NOT_APPLICABLE, "pending");
  }
  const store = enrollments(service);
  if (store.activationRequestId(credentialId) !== receipt.request_id) {
    throw new RemoteApprovalError(REMOTE_ERROR_CODES.REMOTE_APPROVAL_NOT_APPLICABLE, "request");
  }
  const row = service.store.pendingRequest(receipt.request_id);
  if (!row || String(row.action) !== "remote.credential.enroll.activate" || String(row.state) !== "pending") {
    throw new RemoteApprovalError(REMOTE_ERROR_CODES.REMOTE_APPROVAL_NOT_APPLICABLE, "request");
  }
  const args = JSON.parse(String(row.args_json)) as { registration_ceremony_id?: string };
  if (receipt.decision !== "approve" || args.registration_ceremony_id === undefined) {
    throw new RemoteApprovalError(REMOTE_ERROR_CODES.REMOTE_APPROVAL_NOT_APPLICABLE, "receipt");
  }
  if (store.countActiveCredentials(credential.principal_id) >= service.options.policy.remote_approval.active_credential_cap) {
    throw new RemoteApprovalError(REMOTE_ERROR_CODES.REMOTE_RATE_LIMITED, "active_cap");
  }
  try {
    service.options.db.db.transaction(() => {
      service.options.control.decide(receipt, now);
      service.store.activateCredential(credentialId, receipt.request_id, receipt.receipt_id, iso(now));
    }).immediate();
  } catch (error) {
    rethrow(error);
  }
  return { schema_version: 1, credential_id: credentialId, state: "active" };
}

export function stageCredentialRevoke(
  service: RemoteApprovalService, credentialId: string, reason: string, now: Date,
): { schema_version: 1; request_id: string } {
  requireQuarantineClear(service);
  const credential = service.store.credential(credentialId);
  if (!credential || (credential.state !== "active" && credential.state !== "compromised")) {
    throw new RemoteApprovalError(REMOTE_ERROR_CODES.REMOTE_APPROVAL_NOT_APPLICABLE, "credential");
  }
  const requestId = `rcr_${randomBytes(16).toString("hex")}`;
  try {
    service.options.control.stage({
      schema_version: 1, request_id: requestId, action: "remote.credential.revoke", action_level: 3,
      target: {
        principal_id: credential.principal_id,
        credential_id_digest: credential.credential_id_digest,
        public_key_digest: credential.public_key_digest,
      },
      args: { schema_version: 1, reason_digest: sha256Prefixed(reason) },
      reversible: false, requested_by: service.options.policy.owner_principal,
      requested_at: iso(now),
      expires_at: plus(now, service.options.policy.remote_approval.activation_ttl_seconds),
      nonce: `ncr_${randomBytes(16).toString("hex")}`,
    }, now);
  } catch (error) {
    rethrow(error);
  }
  return { schema_version: 1, request_id: requestId };
}

export function revokeCredential(
  service: RemoteApprovalService, credentialId: string, receipt: CommandApprovalReceipt, now: Date,
): { schema_version: 1; state: "revoked" } {
  requireQuarantineClear(service);
  if (receipt.decision !== "approve") throw new RemoteApprovalError(REMOTE_ERROR_CODES.REMOTE_APPROVAL_NOT_APPLICABLE, "receipt");
  try {
    service.options.db.db.transaction(() => {
      service.options.control.decide(receipt, now);
      enrollments(service).revokeCredential(credentialId, iso(now));
    }).immediate();
  } catch (error) {
    rethrow(error);
  }
  return { schema_version: 1, state: "revoked" };
}

export function stagePrincipalRevoke(service: RemoteApprovalService, reason: string, now: Date): { schema_version: 1; request_id: string } {
  requireQuarantineClear(service);
  const owner = service.store.principal();
  if (!owner || owner.state !== "active") throw new RemoteApprovalError(REMOTE_ERROR_CODES.REMOTE_APPROVAL_NOT_APPLICABLE, "principal");
  const requestId = `rrp_${randomBytes(16).toString("hex")}`;
  try {
    service.options.control.stage({
      schema_version: 1, request_id: requestId, action: "remote.principal.revoke", action_level: 4,
      target: { principal_id: owner.principal_id, user_handle_digest: owner.user_handle_digest },
      args: { schema_version: 1, reason_digest: sha256Prefixed(reason) },
      reversible: false, requested_by: service.options.policy.owner_principal,
      requested_at: iso(now),
      expires_at: plus(now, service.options.policy.remote_approval.activation_ttl_seconds),
      nonce: `npr_${randomBytes(16).toString("hex")}`,
    }, now);
  } catch (error) {
    rethrow(error);
  }
  return { schema_version: 1, request_id: requestId };
}

export function revokePrincipal(service: RemoteApprovalService, receipt: CommandApprovalReceipt, now: Date): { schema_version: 1; state: "revoked" } {
  requireQuarantineClear(service);
  const owner = service.store.principal();
  if (!owner) throw new RemoteApprovalError(REMOTE_ERROR_CODES.REMOTE_APPROVAL_NOT_APPLICABLE, "principal");
  if (receipt.decision !== "approve") throw new RemoteApprovalError(REMOTE_ERROR_CODES.REMOTE_APPROVAL_NOT_APPLICABLE, "receipt");
  try {
    service.options.db.db.transaction(() => {
      service.options.control.decide(receipt, now);
      enrollments(service).revokePrincipal(owner.principal_id, iso(now));
    }).immediate();
  } catch (error) {
    rethrow(error);
  }
  return { schema_version: 1, state: "revoked" };
}

export function listCredentials(service: RemoteApprovalService): { schema_version: 1; items: Array<{ credential_id_prefix: string; state: string }> } {
  requireQuarantineClear(service);
  return { schema_version: 1, items: enrollments(service).listCredentials() };
}
