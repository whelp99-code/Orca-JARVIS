import type { AuthorityDb } from "./db.js";
import { RemoteApprovalError, REMOTE_ERROR_CODES } from "./remote-approval-errors.js";

export type RegistrationCeremonyRow = {
  readonly ceremony_id: string;
  readonly enrollment_id: string;
  readonly begin_request_id: string;
  readonly begin_receipt_id: string | null;
  readonly principal_id: string;
  readonly user_handle_digest: string;
  readonly gateway_session_digest: string;
  readonly gateway_owner_digest: string;
  readonly origin: string;
  readonly rp_id: string;
  readonly challenge_b64: string;
  readonly challenge_digest: string;
  readonly nonce_digest: string;
  readonly state: string;
  readonly issued_at: string;
  readonly expires_at: string;
};

export class RemoteEnrollmentStore {
  constructor(private readonly authority: AuthorityDb) {}

  get db() { return this.authority.db; }

  approvedReceipt(requestId: string): { receipt_id: string; expires_at: string } | undefined {
    return this.db.prepare(
      "SELECT receipt_id,expires_at FROM control_command_receipts WHERE request_id=? AND decision='approve'",
    ).get(requestId) as { receipt_id: string; expires_at: string } | undefined;
  }

  liveCredentialIds(): string[] {
    return (this.db.prepare("SELECT credential_id FROM webauthn_credentials_v2").all() as Array<{ credential_id: string }>)
      .map(row => row.credential_id);
  }

  countLiveRegistrations(): number {
    return (this.db.prepare(
      "SELECT COUNT(*) AS n FROM webauthn_registration_ceremonies_v2 WHERE state IN ('issued','verifying')",
    ).get() as { n: number }).n;
  }

  countPendingCredentials(): number {
    return (this.db.prepare(
      "SELECT COUNT(*) AS n FROM webauthn_credentials_v2 WHERE state='pending'",
    ).get() as { n: number }).n;
  }

  countActiveCredentials(principalId: string): number {
    return (this.db.prepare(
      "SELECT COUNT(*) AS n FROM webauthn_credentials_v2 WHERE principal_id=? AND state='active'",
    ).get(principalId) as { n: number }).n;
  }

  expireRegistrations(now: string): void {
    this.db.prepare(
      "UPDATE webauthn_registration_ceremonies_v2 SET state='expired',terminal_reason='expired' WHERE state IN ('issued','verifying') AND julianday(expires_at)<=julianday(?)",
    ).run(now);
  }

  liveRegistration(enrollmentId: string, session: string): RegistrationCeremonyRow | undefined {
    return this.db.prepare(
      "SELECT * FROM webauthn_registration_ceremonies_v2 WHERE enrollment_id=? AND gateway_session_digest=? AND state IN ('issued','verifying')",
    ).get(enrollmentId, session) as RegistrationCeremonyRow | undefined;
  }

  insertRegistration(row: RegistrationCeremonyRow): void {
    this.db.prepare(
      `INSERT INTO webauthn_registration_ceremonies_v2(
        ceremony_id,enrollment_id,begin_request_id,begin_receipt_id,principal_id,user_handle_digest,
        gateway_session_digest,gateway_owner_digest,origin,rp_id,challenge_b64,challenge_digest,nonce_digest,
        state,attempts,issued_at,expires_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,?,?)`,
    ).run(
      row.ceremony_id, row.enrollment_id, row.begin_request_id, row.begin_receipt_id, row.principal_id,
      row.user_handle_digest, row.gateway_session_digest, row.gateway_owner_digest, row.origin, row.rp_id,
      row.challenge_b64, row.challenge_digest, row.nonce_digest, row.state, row.issued_at, row.expires_at,
    );
  }

  ceremony(id: string): RegistrationCeremonyRow | undefined {
    return this.db.prepare("SELECT * FROM webauthn_registration_ceremonies_v2 WHERE ceremony_id=?").get(id) as RegistrationCeremonyRow | undefined;
  }

  reserveRegistration(id: string, reservedAt: string, reservationExpires: string): void {
    const changed = this.db.prepare(
      "UPDATE webauthn_registration_ceremonies_v2 SET state='verifying',attempts=1,reserved_at=?,reservation_expires_at=? WHERE ceremony_id=? AND state='issued'",
    ).run(reservedAt, reservationExpires, id);
    if (changed.changes !== 1) throw new RemoteApprovalError(REMOTE_ERROR_CODES.REMOTE_APPROVAL_NOT_APPLICABLE, "reserve");
  }

  finishRegistration(id: string, state: "consumed" | "rejected", reason: string): void {
    this.db.prepare(
      "UPDATE webauthn_registration_ceremonies_v2 SET state=?,terminal_reason=? WHERE ceremony_id=? AND state='verifying'",
    ).run(state, reason, id);
  }

  insertPendingCredential(row: {
    credential_id: string; credential_id_digest: string; principal_id: string; public_key_cose: string;
    public_key_digest: string; algorithm: number; user_handle_digest: string; sign_count: number;
    counter_mode: "zero" | "monotonic"; backup_eligible: number; backup_state: number;
    registration_ceremony_id: string; activation_request_id: string; pending_expires_at: string; created_at: string;
  }): void {
    this.db.prepare(
      `INSERT INTO webauthn_credentials_v2(
        credential_id,credential_id_digest,principal_id,public_key_cose,public_key_digest,algorithm,
        user_handle_digest,transports_json,sign_count,counter_mode,backup_eligible,backup_state,state,
        registration_ceremony_id,activation_request_id,pending_expires_at,created_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      row.credential_id, row.credential_id_digest, row.principal_id, row.public_key_cose, row.public_key_digest,
      row.algorithm, row.user_handle_digest, "[]", row.sign_count, row.counter_mode, row.backup_eligible,
      row.backup_state, "pending", row.registration_ceremony_id, row.activation_request_id, row.pending_expires_at,
      row.created_at,
    );
  }

  listCredentials(): Array<{ credential_id_prefix: string; state: string }> {
    return (this.db.prepare(
      "SELECT credential_id_digest,state FROM webauthn_credentials_v2 ORDER BY created_at,credential_id",
    ).all() as Array<{ credential_id_digest: string; state: string }>).map(row => ({
      credential_id_prefix: row.credential_id_digest.slice(7, 23),
      state: row.state,
    }));
  }

  activationRequestId(id: string): string | undefined {
    const row = this.db.prepare(
      "SELECT activation_request_id FROM webauthn_credentials_v2 WHERE credential_id=?",
    ).get(id) as { activation_request_id: string | null } | undefined;
    return row?.activation_request_id ?? undefined;
  }

  revokeCredential(id: string, at: string): void {
    const changed = this.db.prepare(
      "UPDATE webauthn_credentials_v2 SET state='revoked',revoked_at=? WHERE credential_id=? AND state IN ('active','compromised')",
    ).run(at, id);
    if (changed.changes !== 1) throw new RemoteApprovalError(REMOTE_ERROR_CODES.REMOTE_APPROVAL_NOT_APPLICABLE, "revoke");
  }

  revokePrincipal(principalId: string, at: string): void {
    const principal = this.db.prepare(
      "UPDATE remote_owner_principals_v2 SET state='revoked',revoked_at=? WHERE principal_id=? AND state='active'",
    ).run(at, principalId);
    if (principal.changes !== 1) throw new RemoteApprovalError(REMOTE_ERROR_CODES.REMOTE_APPROVAL_NOT_APPLICABLE, "principal");
    this.db.prepare(
      "UPDATE webauthn_credentials_v2 SET state='revoked',revoked_at=? WHERE principal_id=? AND state IN ('pending','active','compromised')",
    ).run(at, principalId);
    this.db.prepare(
      "UPDATE webauthn_approval_challenges_v2 SET state='rejected',terminal_reason='principal_revoked' WHERE remote_principal_id=? AND state IN ('issued','verifying')",
    ).run(principalId);
  }
}
