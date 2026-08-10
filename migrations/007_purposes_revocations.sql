CREATE TABLE IF NOT EXISTS authority_key_purposes (key_id TEXT PRIMARY KEY REFERENCES trusted_authority_keys(key_id), purpose TEXT NOT NULL CHECK(purpose IN ('decision','verifier','policy')), created_at TEXT NOT NULL);
INSERT OR IGNORE INTO authority_key_purposes(key_id,purpose,created_at) SELECT key_id, CASE WHEN principal_id='shadow-policy' THEN 'policy' WHEN principal_id='independent-verifier' THEN 'verifier' ELSE 'decision' END, created_at FROM trusted_authority_keys;
CREATE TABLE IF NOT EXISTS authority_revocations (reference TEXT PRIMARY KEY, reason TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TRIGGER immutable_key_purpose_update BEFORE UPDATE ON authority_key_purposes BEGIN SELECT RAISE(ABORT, 'immutable authority key purpose'); END;
CREATE TRIGGER immutable_key_purpose_delete BEFORE DELETE ON authority_key_purposes BEGIN SELECT RAISE(ABORT, 'immutable authority key purpose'); END;
CREATE TRIGGER sealed_key_purpose_insert BEFORE INSERT ON authority_key_purposes WHEN EXISTS(SELECT 1 FROM authority_configuration WHERE id=1) BEGIN SELECT RAISE(ABORT, 'authority key purposes sealed'); END;
CREATE TRIGGER immutable_revocations_update BEFORE UPDATE ON authority_revocations BEGIN SELECT RAISE(ABORT, 'immutable authority revocation'); END;
CREATE TRIGGER immutable_revocations_delete BEFORE DELETE ON authority_revocations BEGIN SELECT RAISE(ABORT, 'immutable authority revocation'); END;
CREATE TRIGGER immutable_outbox_delete BEFORE DELETE ON outbox BEGIN SELECT RAISE(ABORT, 'immutable outbox'); END;
