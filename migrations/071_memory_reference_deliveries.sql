-- Reference submission metadata only. No plaintext memory, query, session ID or model output.
CREATE TABLE personal_context_reference_identity (
  singleton_id INTEGER PRIMARY KEY CHECK(singleton_id=1),
  key_binding TEXT NOT NULL CHECK(key_binding IS NULL OR (length(key_binding)=76 AND substr(key_binding,1,12)='hmac-sha256:' AND substr(key_binding,13) NOT GLOB '*[^0-9a-f]*'))
);
CREATE TRIGGER personal_context_reference_key_insert BEFORE INSERT ON personal_context_reference_identity
WHEN EXISTS(SELECT 1 FROM personal_context_reference_identity)
BEGIN SELECT RAISE(ABORT,'immutable reference key binding'); END;
CREATE TRIGGER personal_context_reference_key_update BEFORE UPDATE ON personal_context_reference_identity
BEGIN SELECT RAISE(ABORT,'immutable reference key binding'); END;
CREATE TRIGGER personal_context_reference_key_delete BEFORE DELETE ON personal_context_reference_identity
BEGIN SELECT RAISE(ABORT,'immutable reference key binding'); END;
CREATE TABLE personal_context_reference_sessions (
  session_key TEXT NOT NULL PRIMARY KEY CHECK(session_key IS NULL OR (length(session_key)=76 AND substr(session_key,1,12)='hmac-sha256:' AND substr(session_key,13) NOT GLOB '*[^0-9a-f]*')),
  binding_key TEXT CHECK(binding_key IS NULL OR (length(binding_key)=76 AND substr(binding_key,1,12)='hmac-sha256:' AND substr(binding_key,13) NOT GLOB '*[^0-9a-f]*')),
  state TEXT NOT NULL CHECK(state IN ('active','invalidated')),
  created_at TEXT NOT NULL CHECK(length(created_at)=24 AND strftime('%Y-%m-%dT%H:%M:%fZ',created_at) IS created_at),
  updated_at TEXT NOT NULL CHECK(length(updated_at)=24 AND strftime('%Y-%m-%dT%H:%M:%fZ',updated_at) IS updated_at AND updated_at>=created_at),
  CHECK((state='active' AND binding_key IS NOT NULL) OR (state='invalidated' AND binding_key IS NULL))
);
CREATE TABLE personal_context_reference_attempts (
  attempt_id TEXT NOT NULL PRIMARY KEY,
  session_key TEXT NOT NULL REFERENCES personal_context_reference_sessions(session_key) CHECK(session_key IS NULL OR (length(session_key)=76 AND substr(session_key,1,12)='hmac-sha256:' AND substr(session_key,13) NOT GLOB '*[^0-9a-f]*')),
  epoch_key TEXT CHECK(epoch_key IS NULL OR (length(epoch_key)=76 AND substr(epoch_key,1,12)='hmac-sha256:' AND substr(epoch_key,13) NOT GLOB '*[^0-9a-f]*')),
  record_set_key TEXT CHECK(record_set_key IS NULL OR (length(record_set_key)=76 AND substr(record_set_key,1,12)='hmac-sha256:' AND substr(record_set_key,13) NOT GLOB '*[^0-9a-f]*')),
  payload_key TEXT CHECK(payload_key IS NULL OR (length(payload_key)=76 AND substr(payload_key,1,12)='hmac-sha256:' AND substr(payload_key,13) NOT GLOB '*[^0-9a-f]*')),
  state TEXT NOT NULL CHECK(state IN ('dispatching','callback_completed','unconfirmed','invalidated')),
  created_at TEXT NOT NULL CHECK(length(created_at)=24 AND strftime('%Y-%m-%dT%H:%M:%fZ',created_at) IS created_at),
  updated_at TEXT NOT NULL CHECK(length(updated_at)=24 AND strftime('%Y-%m-%dT%H:%M:%fZ',updated_at) IS updated_at AND updated_at>=created_at),
  UNIQUE(session_key,epoch_key,record_set_key),
  CHECK((state='invalidated' AND epoch_key IS NULL AND record_set_key IS NULL AND payload_key IS NULL)
    OR (state!='invalidated' AND epoch_key IS NOT NULL AND record_set_key IS NOT NULL AND payload_key IS NOT NULL))
);
CREATE INDEX personal_context_reference_pending
  ON personal_context_reference_attempts(session_key,state);
CREATE TRIGGER personal_context_reference_session_insert BEFORE INSERT ON personal_context_reference_sessions
WHEN NEW.state!='active' OR EXISTS(SELECT 1 FROM personal_context_reference_sessions WHERE session_key=NEW.session_key)
BEGIN SELECT RAISE(ABORT,'reference session already exists'); END;
CREATE TRIGGER personal_context_reference_attempt_insert BEFORE INSERT ON personal_context_reference_attempts
WHEN NEW.state!='dispatching' OR EXISTS(SELECT 1 FROM personal_context_reference_attempts WHERE attempt_id=NEW.attempt_id)
BEGIN SELECT RAISE(ABORT,'reference attempt already exists'); END;
CREATE TRIGGER personal_context_reference_session_delete BEFORE DELETE ON personal_context_reference_sessions
BEGIN SELECT RAISE(ABORT,'immutable reference session marker'); END;
CREATE TRIGGER personal_context_reference_attempt_delete BEFORE DELETE ON personal_context_reference_attempts
BEGIN SELECT RAISE(ABORT,'immutable reference attempt marker'); END;
CREATE TRIGGER personal_context_reference_session_identity BEFORE UPDATE ON personal_context_reference_sessions
WHEN NEW.updated_at<OLD.updated_at OR NEW.session_key!=OLD.session_key OR (NEW.binding_key IS NOT OLD.binding_key AND NOT (NEW.state='invalidated' AND NEW.binding_key IS NULL)) OR NEW.created_at!=OLD.created_at
  OR (OLD.state='invalidated' AND NEW.state!='invalidated')
BEGIN SELECT RAISE(ABORT,'immutable reference session identity'); END;
CREATE TRIGGER personal_context_reference_attempt_identity BEFORE UPDATE ON personal_context_reference_attempts
WHEN NEW.updated_at<OLD.updated_at OR NEW.attempt_id!=OLD.attempt_id OR NEW.session_key!=OLD.session_key OR ((NEW.epoch_key IS NOT OLD.epoch_key OR NEW.record_set_key IS NOT OLD.record_set_key OR NEW.payload_key IS NOT OLD.payload_key)
    AND NOT (NEW.state='invalidated' AND NEW.epoch_key IS NULL AND NEW.record_set_key IS NULL AND NEW.payload_key IS NULL)) OR NEW.created_at!=OLD.created_at
  OR NOT (NEW.state=OLD.state OR (OLD.state='dispatching' AND NEW.state IN ('callback_completed','unconfirmed','invalidated'))
    OR (OLD.state IN ('callback_completed','unconfirmed') AND NEW.state='invalidated'))
BEGIN SELECT RAISE(ABORT,'invalid reference attempt transition'); END;
CREATE TRIGGER personal_context_reference_privacy_invalidated AFTER UPDATE ON memory_read_revision
BEGIN
  UPDATE personal_context_reference_sessions SET state='invalidated',binding_key=NULL,updated_at=MAX(updated_at,strftime('%Y-%m-%dT%H:%M:%fZ','now')) WHERE state='active';
  UPDATE personal_context_reference_attempts SET state='invalidated',epoch_key=NULL,record_set_key=NULL,payload_key=NULL,updated_at=MAX(updated_at,strftime('%Y-%m-%dT%H:%M:%fZ','now')) WHERE state!='invalidated';
END;
CREATE TRIGGER personal_context_reference_tombstone_invalidated AFTER INSERT ON memory_tombstone_chain
BEGIN
  UPDATE personal_context_reference_sessions SET state='invalidated',binding_key=NULL,updated_at=MAX(updated_at,strftime('%Y-%m-%dT%H:%M:%fZ','now')) WHERE state='active';
  UPDATE personal_context_reference_attempts SET state='invalidated',epoch_key=NULL,record_set_key=NULL,payload_key=NULL,updated_at=MAX(updated_at,strftime('%Y-%m-%dT%H:%M:%fZ','now')) WHERE state!='invalidated';
END;
