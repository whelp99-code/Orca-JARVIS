CREATE TABLE remote_auth_legacy_quarantine_v2 (
  singleton INTEGER PRIMARY KEY CHECK(singleton=1),
  remote_principals_count INTEGER NOT NULL CHECK(remote_principals_count>=0),
  webauthn_credentials_count INTEGER NOT NULL CHECK(webauthn_credentials_count>=0),
  webauthn_challenges_count INTEGER NOT NULL CHECK(webauthn_challenges_count>=0),
  webauthn_assertions_count INTEGER NOT NULL CHECK(webauthn_assertions_count>=0),
  installed_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',installed_at)=installed_at)
);
INSERT INTO remote_auth_legacy_quarantine_v2(
  singleton, remote_principals_count, webauthn_credentials_count, webauthn_challenges_count, webauthn_assertions_count, installed_at
) SELECT 1,
  (SELECT COUNT(*) FROM remote_principals),
  (SELECT COUNT(*) FROM webauthn_credentials),
  (SELECT COUNT(*) FROM webauthn_challenges),
  (SELECT COUNT(*) FROM webauthn_assertions),
  strftime('%Y-%m-%dT%H:%M:%fZ','now');

CREATE TRIGGER remote_principals_legacy_insert BEFORE INSERT ON remote_principals BEGIN SELECT RAISE(ABORT,'legacy remote auth write quarantined'); END;
CREATE TRIGGER remote_principals_legacy_update BEFORE UPDATE ON remote_principals BEGIN SELECT RAISE(ABORT,'legacy remote auth write quarantined'); END;
CREATE TRIGGER remote_principals_legacy_delete BEFORE DELETE ON remote_principals BEGIN SELECT RAISE(ABORT,'legacy remote auth write quarantined'); END;
CREATE TRIGGER webauthn_credentials_legacy_insert BEFORE INSERT ON webauthn_credentials BEGIN SELECT RAISE(ABORT,'legacy remote auth write quarantined'); END;
CREATE TRIGGER webauthn_credentials_legacy_update BEFORE UPDATE ON webauthn_credentials BEGIN SELECT RAISE(ABORT,'legacy remote auth write quarantined'); END;
CREATE TRIGGER webauthn_credentials_legacy_delete BEFORE DELETE ON webauthn_credentials BEGIN SELECT RAISE(ABORT,'legacy remote auth write quarantined'); END;
CREATE TRIGGER webauthn_challenges_legacy_insert BEFORE INSERT ON webauthn_challenges BEGIN SELECT RAISE(ABORT,'legacy remote auth write quarantined'); END;
CREATE TRIGGER webauthn_challenges_legacy_update BEFORE UPDATE ON webauthn_challenges BEGIN SELECT RAISE(ABORT,'legacy remote auth write quarantined'); END;
CREATE TRIGGER webauthn_challenges_legacy_delete BEFORE DELETE ON webauthn_challenges BEGIN SELECT RAISE(ABORT,'legacy remote auth write quarantined'); END;
CREATE TRIGGER webauthn_assertions_legacy_insert BEFORE INSERT ON webauthn_assertions BEGIN SELECT RAISE(ABORT,'legacy remote auth write quarantined'); END;
CREATE TRIGGER webauthn_assertions_legacy_update BEFORE UPDATE ON webauthn_assertions BEGIN SELECT RAISE(ABORT,'legacy remote auth write quarantined'); END;
CREATE TRIGGER webauthn_assertions_legacy_delete BEFORE DELETE ON webauthn_assertions BEGIN SELECT RAISE(ABORT,'legacy remote auth write quarantined'); END;

CREATE TABLE remote_owner_principals_v2 (
  singleton INTEGER PRIMARY KEY CHECK(singleton=1),
  principal_id TEXT NOT NULL UNIQUE,
  user_handle BLOB NOT NULL CHECK(length(user_handle)=32),
  user_handle_digest TEXT NOT NULL UNIQUE CHECK(user_handle_digest LIKE 'sha256:%' AND length(user_handle_digest)=71),
  state TEXT NOT NULL CHECK(state IN ('active','revoked')),
  created_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',created_at)=created_at),
  revoked_at TEXT CHECK(revoked_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ',revoked_at)=revoked_at)
);

CREATE TABLE webauthn_registration_ceremonies_v2 (
  ceremony_id TEXT PRIMARY KEY,
  enrollment_id TEXT NOT NULL,
  begin_request_id TEXT NOT NULL,
  begin_receipt_id TEXT,
  principal_id TEXT NOT NULL,
  user_handle_digest TEXT NOT NULL CHECK(user_handle_digest LIKE 'sha256:%' AND length(user_handle_digest)=71),
  gateway_session_digest TEXT NOT NULL CHECK(gateway_session_digest LIKE 'hmac-sha256:%'),
  gateway_owner_digest TEXT NOT NULL CHECK(gateway_owner_digest LIKE 'sha256:%'),
  origin TEXT NOT NULL,
  rp_id TEXT NOT NULL,
  challenge_b64 TEXT NOT NULL,
  challenge_digest TEXT NOT NULL CHECK(challenge_digest LIKE 'sha256:%'),
  nonce_digest TEXT NOT NULL CHECK(nonce_digest LIKE 'sha256:%'),
  state TEXT NOT NULL CHECK(state IN ('issued','verifying','consumed','expired','rejected')),
  attempts INTEGER NOT NULL CHECK(attempts IN (0,1)),
  reserved_at TEXT,
  reservation_expires_at TEXT,
  issued_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',issued_at)=issued_at),
  expires_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',expires_at)=expires_at),
  terminal_reason TEXT,
  CHECK(julianday(expires_at)>julianday(issued_at))
);
CREATE INDEX webauthn_registration_ceremonies_v2_live ON webauthn_registration_ceremonies_v2(state,expires_at,ceremony_id);

CREATE TABLE webauthn_credentials_v2 (
  credential_id TEXT PRIMARY KEY,
  credential_id_digest TEXT NOT NULL UNIQUE CHECK(credential_id_digest LIKE 'sha256:%' AND length(credential_id_digest)=71),
  principal_id TEXT NOT NULL,
  public_key_cose TEXT NOT NULL,
  public_key_digest TEXT NOT NULL CHECK(public_key_digest LIKE 'sha256:%' AND length(public_key_digest)=71),
  algorithm INTEGER NOT NULL CHECK(algorithm IN (-7,-8)),
  user_handle_digest TEXT NOT NULL CHECK(user_handle_digest LIKE 'sha256:%' AND length(user_handle_digest)=71),
  transports_json TEXT NOT NULL,
  sign_count INTEGER NOT NULL CHECK(sign_count>=0),
  counter_mode TEXT NOT NULL CHECK(counter_mode IN ('zero','monotonic')),
  backup_eligible INTEGER NOT NULL CHECK(backup_eligible IN (0,1)),
  backup_state INTEGER NOT NULL CHECK(backup_state IN (0,1)),
  state TEXT NOT NULL CHECK(state IN ('pending','active','compromised','revoked')),
  registration_ceremony_id TEXT,
  activation_request_id TEXT,
  activation_receipt_id TEXT,
  pending_expires_at TEXT,
  created_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',created_at)=created_at),
  activated_at TEXT,
  compromised_at TEXT,
  revoked_at TEXT,
  CHECK(NOT (backup_eligible=0 AND backup_state=1))
);
CREATE INDEX webauthn_credentials_v2_principal ON webauthn_credentials_v2(principal_id,state,credential_id);

CREATE TABLE webauthn_approval_challenges_v2 (
  challenge_id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL,
  decision TEXT NOT NULL CHECK(decision IN ('approve','reject')),
  command_digest TEXT NOT NULL CHECK(command_digest LIKE 'sha256:%'),
  action TEXT NOT NULL,
  action_level INTEGER NOT NULL CHECK(action_level>=0 AND action_level<=3),
  target_digest TEXT NOT NULL CHECK(target_digest LIKE 'sha256:%'),
  args_digest TEXT NOT NULL CHECK(args_digest LIKE 'sha256:%'),
  request_nonce_digest TEXT NOT NULL CHECK(request_nonce_digest LIKE 'sha256:%'),
  remote_principal_id TEXT NOT NULL,
  user_handle_digest TEXT NOT NULL CHECK(user_handle_digest LIKE 'sha256:%'),
  gateway_owner_digest TEXT NOT NULL CHECK(gateway_owner_digest LIKE 'sha256:%'),
  gateway_session_digest TEXT NOT NULL CHECK(gateway_session_digest LIKE 'hmac-sha256:%'),
  origin TEXT NOT NULL,
  rp_id TEXT NOT NULL,
  challenge_b64 TEXT NOT NULL,
  challenge_nonce TEXT NOT NULL,
  binding_digest TEXT NOT NULL CHECK(binding_digest LIKE 'sha256:%'),
  state TEXT NOT NULL CHECK(state IN ('issued','verifying','consumed','expired','rejected')),
  attempts INTEGER NOT NULL CHECK(attempts IN (0,1)),
  reserved_at TEXT,
  reservation_expires_at TEXT,
  issued_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',issued_at)=issued_at),
  expires_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',expires_at)=expires_at),
  terminal_reason TEXT,
  CHECK(julianday(expires_at)>julianday(issued_at))
);
CREATE UNIQUE INDEX webauthn_approval_challenges_v2_live
  ON webauthn_approval_challenges_v2(request_id,decision,gateway_session_digest)
  WHERE state IN ('issued','verifying');
CREATE INDEX webauthn_approval_challenges_v2_state ON webauthn_approval_challenges_v2(state,expires_at,challenge_id);

CREATE TABLE webauthn_assertions_v2 (
  assertion_id TEXT PRIMARY KEY,
  challenge_id TEXT NOT NULL UNIQUE,
  request_id TEXT NOT NULL,
  credential_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  gateway_session_digest TEXT NOT NULL,
  decision TEXT NOT NULL CHECK(decision IN ('approve','reject')),
  assertion_digest TEXT NOT NULL UNIQUE CHECK(assertion_digest LIKE 'sha256:%'),
  client_digest TEXT NOT NULL CHECK(client_digest LIKE 'sha256:%'),
  authenticator_digest TEXT NOT NULL CHECK(authenticator_digest LIKE 'sha256:%'),
  signature_digest TEXT NOT NULL CHECK(signature_digest LIKE 'sha256:%'),
  handle_digest TEXT NOT NULL CHECK(handle_digest LIKE 'sha256:%'),
  sign_count INTEGER NOT NULL CHECK(sign_count>=0),
  up INTEGER NOT NULL CHECK(up=1),
  uv INTEGER NOT NULL CHECK(uv=1),
  backup_eligible INTEGER NOT NULL CHECK(backup_eligible IN (0,1)),
  backup_state INTEGER NOT NULL CHECK(backup_state IN (0,1)),
  origin TEXT NOT NULL,
  rp_id TEXT NOT NULL,
  asserted_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',asserted_at)=asserted_at)
);
CREATE UNIQUE INDEX webauthn_assertions_v2_counter ON webauthn_assertions_v2(credential_id,sign_count) WHERE sign_count>0;
CREATE TRIGGER webauthn_assertions_v2_immutable_update BEFORE UPDATE ON webauthn_assertions_v2 BEGIN SELECT RAISE(ABORT,'immutable webauthn assertion v2'); END;

CREATE TABLE remote_approval_translations_v2 (
  translation_id TEXT PRIMARY KEY,
  assertion_id TEXT NOT NULL UNIQUE,
  challenge_id TEXT NOT NULL UNIQUE,
  request_id TEXT NOT NULL UNIQUE,
  receipt_id TEXT NOT NULL UNIQUE,
  binding_digest TEXT NOT NULL CHECK(binding_digest LIKE 'sha256:%'),
  translated_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',translated_at)=translated_at)
);
CREATE TRIGGER remote_approval_translations_v2_immutable_update BEFORE UPDATE ON remote_approval_translations_v2 BEGIN SELECT RAISE(ABORT,'immutable remote translation'); END;

CREATE TABLE remote_gateway_ingress_nonces_v2 (
  nonce_digest TEXT PRIMARY KEY CHECK(nonce_digest LIKE 'sha256:%'),
  session_digest TEXT NOT NULL,
  body_digest TEXT NOT NULL,
  issued_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  CHECK(julianday(expires_at)>julianday(issued_at))
);

CREATE TABLE remote_auth_retention_authorizations_v2 (
  authorization_id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  fence INTEGER NOT NULL,
  cutoff TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('applying','completed','failed')),
  authorization_digest TEXT NOT NULL UNIQUE CHECK(authorization_digest LIKE 'sha256:%'),
  created_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE TABLE remote_auth_retention_tombstones_v2 (
  tombstone_id TEXT PRIMARY KEY,
  subject_kind TEXT NOT NULL,
  subject_digest TEXT NOT NULL CHECK(subject_digest LIKE 'sha256:%'),
  credential_id_digest TEXT CHECK(credential_id_digest IS NULL OR credential_id_digest LIKE 'sha256:%'),
  public_key_digest TEXT CHECK(public_key_digest IS NULL OR public_key_digest LIKE 'sha256:%'),
  deletion_digest TEXT NOT NULL CHECK(deletion_digest LIKE 'sha256:%'),
  retention_authorization_id TEXT NOT NULL,
  cutoff TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TRIGGER remote_auth_retention_tombstones_v2_immutable_update BEFORE UPDATE ON remote_auth_retention_tombstones_v2 BEGIN SELECT RAISE(ABORT,'immutable remote tombstone'); END;
CREATE TRIGGER remote_auth_retention_tombstones_v2_immutable_delete BEFORE DELETE ON remote_auth_retention_tombstones_v2 BEGIN SELECT RAISE(ABORT,'immutable remote tombstone'); END;

CREATE TABLE remote_auth_counter_signals_v2 (
  signal_id TEXT PRIMARY KEY,
  credential_digest TEXT NOT NULL CHECK(credential_digest LIKE 'sha256:%'),
  challenge_id TEXT NOT NULL,
  assertion_digest TEXT CHECK(assertion_digest IS NULL OR assertion_digest LIKE 'sha256:%'),
  stored_count INTEGER NOT NULL,
  returned_count INTEGER NOT NULL,
  reason TEXT NOT NULL,
  observed_at TEXT NOT NULL
);
CREATE TRIGGER remote_auth_counter_signals_v2_immutable_update BEFORE UPDATE ON remote_auth_counter_signals_v2 BEGIN SELECT RAISE(ABORT,'immutable remote counter signal'); END;

ALTER TABLE personal_operation_audit_events ADD COLUMN outcome TEXT;
ALTER TABLE personal_operation_audit_events ADD COLUMN reason_code TEXT;
ALTER TABLE personal_operation_audit_events ADD COLUMN credential_digest_prefix TEXT;
ALTER TABLE personal_operation_audit_events ADD COLUMN request_digest TEXT;
ALTER TABLE personal_operation_audit_events ADD COLUMN command_digest TEXT;
ALTER TABLE personal_operation_audit_events ADD COLUMN binding_digest TEXT;
ALTER TABLE personal_operation_audit_events ADD COLUMN assertion_digest TEXT;
ALTER TABLE personal_operation_audit_events ADD COLUMN counter_disposition TEXT;
ALTER TABLE personal_operation_audit_events ADD COLUMN up INTEGER;
ALTER TABLE personal_operation_audit_events ADD COLUMN uv INTEGER;
ALTER TABLE personal_operation_audit_events ADD COLUMN origin_digest TEXT;
ALTER TABLE personal_operation_audit_events ADD COLUMN rp_id_digest TEXT;
ALTER TABLE personal_operation_audit_events ADD COLUMN retention_authorization_id TEXT;

CREATE TRIGGER remote_audit_terminal_guard BEFORE INSERT ON personal_operation_audit_events
WHEN NEW.event_type LIKE 'remote.%' BEGIN
  SELECT RAISE(ABORT,'remote audit incomplete')
  WHERE NEW.outcome IS NULL OR NEW.reason_code IS NULL OR NEW.counter_disposition IS NULL
    OR NEW.origin_digest IS NULL OR NEW.rp_id_digest IS NULL
    OR NEW.outcome NOT IN ('translated','rejected','expired','revoked','purged')
    OR NEW.counter_disposition NOT IN ('zero','advanced','nonincreasing','not_checked');
END;

DROP TRIGGER IF EXISTS personal_operation_audit_immutable_delete;
CREATE TRIGGER personal_operation_audit_guarded_delete BEFORE DELETE ON personal_operation_audit_events
BEGIN
  SELECT RAISE(ABORT,'personal operation audit delete unauthorized')
  WHERE OLD.event_type NOT LIKE 'remote.%' OR NOT EXISTS (
    SELECT 1 FROM remote_auth_retention_authorizations_v2 a
    JOIN retention_jobs j ON j.job_id=a.job_id
    WHERE a.state='applying' AND j.data_class='audit' AND j.job_key LIKE 'remote-auth:%'
      AND j.state='claimed' AND j.lease_fence=a.fence AND j.lease_owner IS NOT NULL
      AND julianday(OLD.created_at)<julianday(a.cutoff)
  );
END;
