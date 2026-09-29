CREATE TABLE owner_decision_key_enrollments (
  key_id TEXT PRIMARY KEY REFERENCES trusted_authority_keys(key_id),
  authorized_by TEXT NOT NULL REFERENCES trusted_authority_keys(key_id),
  proof_digest TEXT NOT NULL UNIQUE,
  enrolled_at TEXT NOT NULL
);
CREATE TRIGGER owner_key_enrollment_immutable_update BEFORE UPDATE ON owner_decision_key_enrollments
BEGIN SELECT RAISE(ABORT, 'immutable owner key enrollment'); END;
CREATE TRIGGER owner_key_enrollment_immutable_delete BEFORE DELETE ON owner_decision_key_enrollments
BEGIN SELECT RAISE(ABORT, 'immutable owner key enrollment'); END;
