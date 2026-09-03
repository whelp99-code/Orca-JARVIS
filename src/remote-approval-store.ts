import type { AuthorityDb } from "./db.js";
import { sha256Prefixed } from "./remote-approval-crypto.js";
import { RemoteApprovalError, REMOTE_ERROR_CODES } from "./remote-approval-errors.js";

export type ChallengeRow = {
  readonly challenge_id: string;
  readonly request_id: string;
  readonly decision: "approve" | "reject";
  readonly command_digest: string;
  readonly action: string;
  readonly action_level: number;
  readonly target_digest: string;
  readonly args_digest: string;
  readonly request_nonce_digest: string;
  readonly remote_principal_id: string;
  readonly user_handle_digest: string;
  readonly gateway_owner_digest: string;
  readonly gateway_session_digest: string;
  readonly origin: string;
  readonly rp_id: string;
  readonly challenge_b64: string;
  readonly challenge_nonce: string;
  readonly binding_digest: string;
  readonly state: string;
  readonly attempts: number;
  readonly reserved_at: string | null;
  readonly reservation_expires_at: string | null;
  readonly issued_at: string;
  readonly expires_at: string;
};

export type CredentialRow = {
  readonly credential_id: string;
  readonly credential_id_digest: string;
  readonly principal_id: string;
  readonly public_key_cose: string;
  readonly public_key_digest: string;
  readonly algorithm: number;
  readonly user_handle_digest: string;
  readonly sign_count: number;
  readonly counter_mode: "zero" | "monotonic";
  readonly backup_eligible: number;
  readonly backup_state: number;
  readonly state: string;
};

export type PrincipalRow = {
  readonly principal_id: string;
  readonly user_handle: Buffer;
  readonly user_handle_digest: string;
  readonly state: string;
};

type QuarantineCounts = {
  remote_principals_count: number; webauthn_credentials_count: number;
  webauthn_challenges_count: number; webauthn_assertions_count: number;
};
type TranslationRow = {
  translation_id: string; assertion_id: string; challenge_id: string; request_id: string;
  receipt_id: string; binding_digest: string; translated_at: string;
};
type CounterSignalRow = {
  credential_digest: string; challenge_id: string; assertion_digest: string | null;
  stored_count: number; returned_count: number; reason: string; observed_at: string;
};

export class RemoteApprovalStore {
  constructor(private readonly authority: AuthorityDb) {}

  get db() { return this.authority.db; }

  quarantineCounts(): QuarantineCounts {
    return this.db.prepare(
      "SELECT remote_principals_count, webauthn_credentials_count, webauthn_challenges_count, webauthn_assertions_count FROM " +
        "remote_auth_legacy_quarantine_v2 WHERE singleton=1",
    ).get() as { remote_principals_count: number; webauthn_credentials_count: number; webauthn_challenges_count: number; webauthn_assertions_count: number };
  }

  sealedDecision(keyId: string): { public_key_pem: string; principal_id: string } | undefined {
    return this.db.prepare(
      `SELECT k.public_key_pem,k.principal_id FROM trusted_authority_keys k
       JOIN authority_key_purposes p ON p.key_id=k.key_id
       WHERE k.key_id=? AND p.purpose='decision'`,
    ).get(keyId) as { public_key_pem: string; principal_id: string } | undefined;
  }

  principal(): PrincipalRow | undefined {
    const row = this.db.prepare("SELECT principal_id,user_handle,user_handle_digest,state FROM remote_owner_principals_v2 WHERE singleton=1").get() as
      | { principal_id: string; user_handle: Buffer; user_handle_digest: string; state: string } | undefined;
    return row;
  }

  insertPrincipal(row: { principal_id: string; user_handle: Buffer; user_handle_digest: string; created_at: string }): void {
    this.db.prepare(
      "INSERT INTO remote_owner_principals_v2(singleton,principal_id,user_handle,user_handle_digest,state,created_at) VALUES(1,?,?,?,?,?)",
    ).run(row.principal_id, row.user_handle, row.user_handle_digest, "active", row.created_at);
  }

  credential(id: string): CredentialRow | undefined {
    return this.db.prepare("SELECT * FROM webauthn_credentials_v2 WHERE credential_id=?").get(id) as CredentialRow | undefined;
  }

  activeCredentials(principalId: string): CredentialRow[] {
    return this.db.prepare("SELECT * FROM webauthn_credentials_v2 WHERE principal_id=? AND state='active'").all(principalId) as CredentialRow[];
  }

  insertCredential(row: CredentialRow & { transports_json: string; created_at: string; pending_expires_at: string | null }): void {
    this.db.prepare(
      `INSERT INTO webauthn_credentials_v2(
        credential_id,credential_id_digest,principal_id,public_key_cose,public_key_digest,algorithm,
        user_handle_digest,transports_json,sign_count,counter_mode,backup_eligible,backup_state,state,
        pending_expires_at,created_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      row.credential_id, row.credential_id_digest, row.principal_id, row.public_key_cose, row.public_key_digest,
      row.algorithm, row.user_handle_digest, row.transports_json, row.sign_count, row.counter_mode,
      row.backup_eligible, row.backup_state, row.state, row.pending_expires_at, row.created_at,
    );
  }

  activateCredential(id: string, requestId: string, receiptId: string, at: string): void {
    const changed = this.db.prepare(
      "UPDATE webauthn_credentials_v2 SET state='active',activation_request_id=?,activation_receipt_id=?,activated_at=? WHERE " +
        "credential_id=? AND state='pending'",
    ).run(requestId, receiptId, at, id);
    if (changed.changes !== 1) throw new RemoteApprovalError(REMOTE_ERROR_CODES.REMOTE_APPROVAL_NOT_APPLICABLE, "activate");
  }

  updateCounter(id: string, count: number, mode: "zero" | "monotonic", backupState: number): void {
    this.db.prepare("UPDATE webauthn_credentials_v2 SET sign_count=?,counter_mode=?,backup_state=? WHERE credential_id=?").run(count, mode, backupState, id);
  }

  tombstoneMatch(credentialIdDigest: string, publicKeyDigest: string): boolean {
    const row = this.db.prepare(
      "SELECT 1 FROM remote_auth_retention_tombstones_v2 WHERE credential_id_digest=? OR public_key_digest=?",
    ).get(credentialIdDigest, publicKeyDigest);
    return Boolean(row);
  }

  liveCredentialDigestMatch(credentialIdDigest: string, publicKeyDigest: string): boolean {
    const row = this.db.prepare(
      "SELECT 1 FROM webauthn_credentials_v2 WHERE credential_id_digest=? OR public_key_digest=?",
    ).get(credentialIdDigest, publicKeyDigest);
    return Boolean(row);
  }

  challenge(id: string): ChallengeRow | undefined {
    return this.db.prepare("SELECT * FROM webauthn_approval_challenges_v2 WHERE challenge_id=?").get(id) as ChallengeRow | undefined;
  }

  liveChallenge(requestId: string, decision: string, session: string): ChallengeRow | undefined {
    return this.db.prepare(
      "SELECT * FROM webauthn_approval_challenges_v2 WHERE request_id=? AND decision=? AND gateway_session_digest=? AND state IN " +
        "('issued','verifying')",
    ).get(requestId, decision, session) as ChallengeRow | undefined;
  }

  oppositeLive(requestId: string, decision: string, session: string): boolean {
    const other = decision === "approve" ? "reject" : "approve";
    return Boolean(this.liveChallenge(requestId, other, session));
  }

  expireChallenges(now: string): void {
    this.db.prepare(
      "UPDATE webauthn_approval_challenges_v2 SET state='expired',terminal_reason='expired' WHERE state IN ('issued','verifying') " +
        "AND julianday(expires_at)<=julianday(?)",
    ).run(now);
    this.db.prepare(
      "UPDATE webauthn_approval_challenges_v2 SET state='rejected',terminal_reason='reservation_expired' WHERE state='verifying' " +
        "AND reservation_expires_at IS NOT NULL AND julianday(reservation_expires_at)<=julianday(?)",
    ).run(now);
  }

  recoverVerifying(now: string): void {
    this.db.prepare(
      "UPDATE webauthn_approval_challenges_v2 SET state='rejected',terminal_reason='stranded_verifying' WHERE state='verifying'",
    ).run();
    this.expireChallenges(now);
  }

  countLiveChallenges(): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM webauthn_approval_challenges_v2 WHERE state IN ('issued','verifying')").get() as { n: number }).n;
  }

  insertChallenge(row: ChallengeRow): void {
    this.db.prepare(
      `INSERT INTO webauthn_approval_challenges_v2(
        challenge_id,request_id,decision,command_digest,action,action_level,target_digest,args_digest,
        request_nonce_digest,remote_principal_id,user_handle_digest,gateway_owner_digest,gateway_session_digest,
        origin,rp_id,challenge_b64,challenge_nonce,binding_digest,state,attempts,issued_at,expires_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,?,?)`,
    ).run(
      row.challenge_id, row.request_id, row.decision, row.command_digest, row.action, row.action_level,
      row.target_digest, row.args_digest, row.request_nonce_digest, row.remote_principal_id, row.user_handle_digest,
      row.gateway_owner_digest, row.gateway_session_digest, row.origin, row.rp_id, row.challenge_b64,
      row.challenge_nonce, row.binding_digest, row.state, row.issued_at, row.expires_at,
    );
  }

  reserveChallenge(id: string, reservedAt: string, reservationExpires: string): void {
    const changed = this.db.prepare(
      "UPDATE webauthn_approval_challenges_v2 SET state='verifying',attempts=1,reserved_at=?,reservation_expires_at=? WHERE " +
        "challenge_id=? AND state='issued'",
    ).run(reservedAt, reservationExpires, id);
    if (changed.changes !== 1) throw new RemoteApprovalError(REMOTE_ERROR_CODES.REMOTE_APPROVAL_NOT_APPLICABLE, "reserve");
  }

  finishChallenge(id: string, state: "consumed" | "rejected", reason: string): void {
    this.db.prepare(
      "UPDATE webauthn_approval_challenges_v2 SET state=?,terminal_reason=? WHERE challenge_id=? AND state='verifying'",
    ).run(state, reason, id);
  }

  insertAssertion(row: {
    assertion_id: string; challenge_id: string; request_id: string; credential_id: string; principal_id: string;
    gateway_session_digest: string; decision: string; assertion_digest: string; client_digest: string;
    authenticator_digest: string; signature_digest: string; handle_digest: string; sign_count: number;
    backup_eligible: number; backup_state: number; origin: string; rp_id: string; asserted_at: string;
  }): void {
    this.db.prepare(
      `INSERT INTO webauthn_assertions_v2(
        assertion_id,challenge_id,request_id,credential_id,principal_id,gateway_session_digest,decision,
        assertion_digest,client_digest,authenticator_digest,signature_digest,handle_digest,sign_count,up,uv,
        backup_eligible,backup_state,origin,rp_id,asserted_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,1,1,?,?,?,?,?)`,
    ).run(
      row.assertion_id, row.challenge_id, row.request_id, row.credential_id, row.principal_id,
      row.gateway_session_digest, row.decision, row.assertion_digest, row.client_digest, row.authenticator_digest,
      row.signature_digest, row.handle_digest, row.sign_count, row.backup_eligible, row.backup_state,
      row.origin, row.rp_id, row.asserted_at,
    );
  }

  insertTranslation(row: TranslationRow): void {
    this.db.prepare(
      "INSERT INTO remote_approval_translations_v2(translation_id,assertion_id,challenge_id,request_id,receipt_id,binding_digest,translated_at) " +
        "VALUES(?,?,?,?,?,?,?)",
    ).run(row.translation_id, row.assertion_id, row.challenge_id, row.request_id, row.receipt_id, row.binding_digest, row.translated_at);
  }

  insertCounterSignal(row: CounterSignalRow): void {
    this.db.prepare(
      "INSERT INTO remote_auth_counter_signals_v2(signal_id,credential_digest,challenge_id,assertion_digest,stored_count,returned_count,reason,observed_at) " +
        "VALUES(?,?,?,?,?,?,?,?)",
    ).run(
      `sig:${sha256Prefixed(row.challenge_id + row.reason).slice(7, 23)}`,
      row.credential_digest, row.challenge_id, row.assertion_digest,
      row.stored_count, row.returned_count, row.reason, row.observed_at,
    );
  }

  pendingRequest(requestId: string): Record<string, unknown> | undefined {
    return this.db.prepare("SELECT * FROM control_command_requests WHERE request_id=?").get(requestId) as Record<string, unknown> | undefined;
  }

  receiptCount(requestId: string): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM control_command_receipts WHERE request_id=?").get(requestId) as { n: number }).n;
  }

  insertAudit(row: {
    event_id: string; event_type: string; subject_kind: string; subject_id: string; principal_id: string;
    correlation_id: string; event_digest: string; created_at: string; outcome: string; reason_code: string;
    credential_digest_prefix: string | null; request_digest: string | null; command_digest: string | null;
    binding_digest: string | null; assertion_digest: string | null; counter_disposition: string;
    up: number | null; uv: number | null; origin_digest: string; rp_id_digest: string;
  }): void {
    this.db.prepare(
      `INSERT INTO personal_operation_audit_events(
        event_id,event_type,subject_kind,subject_id,principal_id,correlation_id,event_digest,created_at,
        outcome,reason_code,credential_digest_prefix,request_digest,command_digest,binding_digest,assertion_digest,
        counter_disposition,up,uv,origin_digest,rp_id_digest
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      row.event_id, row.event_type, row.subject_kind, row.subject_id, row.principal_id, row.correlation_id,
      row.event_digest, row.created_at, row.outcome, row.reason_code, row.credential_digest_prefix,
      row.request_digest, row.command_digest, row.binding_digest, row.assertion_digest, row.counter_disposition,
      row.up, row.uv, row.origin_digest, row.rp_id_digest,
    );
  }
}
