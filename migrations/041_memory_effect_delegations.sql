-- Task 30 one-shot Ed25519 delegation authority and revocation journal.
CREATE TABLE memory_effect_delegation_keys (
  key_id TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL CHECK(principal_id='principal:owner'),
  algorithm TEXT NOT NULL CHECK(algorithm='Ed25519'),
  public_key_pem TEXT NOT NULL,
  key_fingerprint TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL CHECK(state IN ('active','revoked')),
  valid_from TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',valid_from)=valid_from),
  valid_until TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',valid_until)=valid_until),
  created_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',created_at)=created_at),
  CHECK(julianday(valid_until)>julianday(valid_from))
);

CREATE TABLE memory_external_erasure_keys (
  key_id TEXT PRIMARY KEY,
  owner_id_digest TEXT NOT NULL,
  algorithm TEXT NOT NULL CHECK(algorithm='Ed25519'),
  public_key_pem TEXT NOT NULL,
  key_fingerprint TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL CHECK(state IN ('active','revoked')),
  valid_from TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',valid_from)=valid_from),
  valid_until TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',valid_until)=valid_until),
  created_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',created_at)=created_at),
  CHECK(julianday(valid_until)>julianday(valid_from))
);

CREATE TABLE memory_effect_delegations (
  delegation_id TEXT PRIMARY KEY CHECK(delegation_id GLOB 'memdeleg:v1:[0-9a-f]*' AND length(delegation_id)=76),
  delegation_digest TEXT NOT NULL UNIQUE,
  request_id TEXT NOT NULL UNIQUE REFERENCES memory_effect_requests(request_id),
  signing_key_id TEXT NOT NULL REFERENCES memory_effect_delegation_keys(key_id),
  nonce TEXT NOT NULL UNIQUE,
  payload_json TEXT NOT NULL,
  signature TEXT NOT NULL,
  issued_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',issued_at)=issued_at),
  not_before TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',not_before)=not_before),
  expires_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',expires_at)=expires_at),
  max_uses INTEGER NOT NULL CHECK(max_uses=1),
  created_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',created_at)=created_at),
  CHECK(julianday(expires_at)>julianday(not_before) AND julianday(not_before)>=julianday(issued_at))
);

CREATE TABLE memory_effect_delegation_revocations (
  revocation_id TEXT PRIMARY KEY,
  delegation_id TEXT NOT NULL UNIQUE,
  reason TEXT NOT NULL,
  revoked_by TEXT NOT NULL,
  revoked_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',revoked_at)=revoked_at),
  payload_digest TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',created_at)=created_at)
);

CREATE TABLE memory_effect_delegation_uses (
  delegation_id TEXT PRIMARY KEY REFERENCES memory_effect_delegations(delegation_id),
  request_id TEXT NOT NULL UNIQUE REFERENCES memory_effect_requests(request_id),
  control_request_id TEXT NOT NULL UNIQUE REFERENCES control_command_requests(request_id),
  used_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',used_at)=used_at)
);

CREATE TRIGGER memory_effect_delegations_request_guard BEFORE INSERT ON memory_effect_delegations
WHEN EXISTS (SELECT 1 FROM memory_effect_delegation_revocations v WHERE v.delegation_id=NEW.delegation_id)
  OR NOT EXISTS (
  SELECT 1 FROM memory_effect_requests r WHERE r.request_id=NEW.request_id
    AND r.delegation_id=NEW.delegation_id AND r.state='prepared'
) OR NOT EXISTS (
  SELECT 1 FROM memory_effect_delegation_keys k WHERE k.key_id=NEW.signing_key_id
    AND k.state='active' AND julianday(k.valid_from)<=julianday(NEW.issued_at)
    AND julianday(k.valid_until)>=julianday(NEW.expires_at)
)
BEGIN SELECT RAISE(ABORT,'memory delegation authority invalid'); END;

CREATE TRIGGER memory_effect_delegation_use_guard BEFORE INSERT ON memory_effect_delegation_uses
WHEN EXISTS (SELECT 1 FROM memory_effect_delegation_revocations v WHERE v.delegation_id=NEW.delegation_id)
  OR NOT EXISTS (
    SELECT 1 FROM memory_effect_delegations d JOIN memory_effect_requests r ON r.request_id=d.request_id
    WHERE d.delegation_id=NEW.delegation_id AND d.request_id=NEW.request_id
      AND r.control_request_id=NEW.control_request_id AND r.state='prepared'
      AND julianday(d.not_before)<=julianday(NEW.used_at) AND julianday(d.expires_at)>julianday(NEW.used_at)
  )
BEGIN SELECT RAISE(ABORT,'memory delegation unavailable'); END;

CREATE TRIGGER memory_effect_delegation_keys_identity BEFORE UPDATE OF
  key_id,principal_id,algorithm,public_key_pem,key_fingerprint,valid_from,valid_until,created_at
  ON memory_effect_delegation_keys BEGIN SELECT RAISE(ABORT,'immutable memory delegation key'); END;
CREATE TRIGGER memory_external_erasure_keys_identity BEFORE UPDATE OF
  key_id,owner_id_digest,algorithm,public_key_pem,key_fingerprint,valid_from,valid_until,created_at
  ON memory_external_erasure_keys BEGIN SELECT RAISE(ABORT,'immutable external erasure key'); END;
CREATE TRIGGER memory_effect_delegations_immutable_update BEFORE UPDATE ON memory_effect_delegations
  BEGIN SELECT RAISE(ABORT,'immutable memory delegation'); END;
CREATE TRIGGER memory_effect_delegations_immutable_delete BEFORE DELETE ON memory_effect_delegations
  BEGIN SELECT RAISE(ABORT,'immutable memory delegation'); END;
CREATE TRIGGER memory_effect_delegation_revocations_immutable_update BEFORE UPDATE ON memory_effect_delegation_revocations
  BEGIN SELECT RAISE(ABORT,'immutable memory delegation revocation'); END;
CREATE TRIGGER memory_effect_delegation_revocations_immutable_delete BEFORE DELETE ON memory_effect_delegation_revocations
  BEGIN SELECT RAISE(ABORT,'immutable memory delegation revocation'); END;
CREATE TRIGGER memory_effect_delegation_uses_immutable_update BEFORE UPDATE ON memory_effect_delegation_uses
  BEGIN SELECT RAISE(ABORT,'immutable memory delegation use'); END;
CREATE TRIGGER memory_effect_delegation_uses_immutable_delete BEFORE DELETE ON memory_effect_delegation_uses
  BEGIN SELECT RAISE(ABORT,'immutable memory delegation use'); END;
