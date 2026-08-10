-- GJC is an optional coordinator transport.  Configuration is append-audited
-- and the current row must point at its immutable audit revision.
CREATE TABLE gjc_runtime_config_audit (
  revision INTEGER PRIMARY KEY AUTOINCREMENT, canonical_cwd TEXT NOT NULL,
  session_id TEXT NOT NULL, profile TEXT NOT NULL CHECK(profile='jarvis'),
  repo TEXT NOT NULL CHECK(repo='Orca-JARVIS'), enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),
  config_digest TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL
);
CREATE TABLE gjc_runtime_config (
  id INTEGER PRIMARY KEY CHECK(id=1), canonical_cwd TEXT NOT NULL, session_id TEXT NOT NULL,
  profile TEXT NOT NULL CHECK(profile='jarvis'), repo TEXT NOT NULL CHECK(repo='Orca-JARVIS'),
  enabled INTEGER NOT NULL CHECK(enabled IN (0,1)), revision INTEGER NOT NULL REFERENCES gjc_runtime_config_audit(revision),
  config_digest TEXT NOT NULL, registration_receipt_json TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TRIGGER gjc_runtime_config_audit_immutable_update BEFORE UPDATE ON gjc_runtime_config_audit BEGIN SELECT RAISE(ABORT,'immutable gjc config audit'); END;
CREATE TRIGGER gjc_runtime_config_audit_immutable_delete BEFORE DELETE ON gjc_runtime_config_audit BEGIN SELECT RAISE(ABORT,'immutable gjc config audit'); END;
CREATE TABLE gjc_runtime_leases (
  id INTEGER PRIMARY KEY CHECK(id=1), owner TEXT NOT NULL, fence INTEGER NOT NULL CHECK(fence>0),
  expires_at TEXT NOT NULL, heartbeat_at TEXT NOT NULL
);
CREATE TABLE gjc_runtime_status (
  id INTEGER PRIMARY KEY CHECK(id=1), pid INTEGER NOT NULL, last_heartbeat_at TEXT NOT NULL,
  last_error_code TEXT, updated_at TEXT NOT NULL
);

CREATE TABLE gjc_intents (
  intent_id TEXT PRIMARY KEY, continuation_id TEXT, kind TEXT NOT NULL CHECK(kind IN ('sync','dispatch','answer')),
  payload_json TEXT NOT NULL, payload_digest TEXT NOT NULL, idempotency_key TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL CHECK(state IN ('pending','claimed','accepted','completed','failed','uncertain','blocked')),
  attempts INTEGER NOT NULL DEFAULT 0, lease_owner TEXT, lease_fence INTEGER NOT NULL DEFAULT 0, lease_expires_at TEXT,
  receipt_json TEXT, accepted_at TEXT, completed_at TEXT, failure_code TEXT, created_at TEXT NOT NULL
);
CREATE TABLE gjc_intent_events (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT, intent_id TEXT NOT NULL REFERENCES gjc_intents(intent_id),
  event_type TEXT NOT NULL, payload_json TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE gjc_intent_audits (
  audit_id TEXT PRIMARY KEY, intent_id TEXT NOT NULL REFERENCES gjc_intents(intent_id), fact_type TEXT NOT NULL,
  payload_json TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX gjc_intents_pending ON gjc_intents(state,created_at,intent_id);
CREATE TRIGGER gjc_intent_identity_immutable BEFORE UPDATE OF intent_id,continuation_id,kind,payload_json,payload_digest,idempotency_key ON gjc_intents BEGIN SELECT RAISE(ABORT,'immutable gjc intent identity'); END;
CREATE TRIGGER gjc_intent_events_immutable_update BEFORE UPDATE ON gjc_intent_events BEGIN SELECT RAISE(ABORT,'immutable gjc event'); END;
CREATE TRIGGER gjc_intent_events_immutable_delete BEFORE DELETE ON gjc_intent_events BEGIN SELECT RAISE(ABORT,'immutable gjc event'); END;
CREATE TRIGGER gjc_intent_audits_immutable_update BEFORE UPDATE ON gjc_intent_audits BEGIN SELECT RAISE(ABORT,'immutable gjc audit'); END;
CREATE TRIGGER gjc_intent_audits_immutable_delete BEFORE DELETE ON gjc_intent_audits BEGIN SELECT RAISE(ABORT,'immutable gjc audit'); END;

CREATE TABLE gjc_questions (
  question_id TEXT PRIMARY KEY, intent_id TEXT NOT NULL REFERENCES gjc_intents(intent_id),
  snapshot_json TEXT NOT NULL, snapshot_digest TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('open','answered','blocked')),
  created_at TEXT NOT NULL, answered_at TEXT, UNIQUE(intent_id,question_id)
);
CREATE TABLE gjc_question_answers (
  question_id TEXT PRIMARY KEY REFERENCES gjc_questions(question_id), idempotency_key TEXT NOT NULL UNIQUE,
  answer_json TEXT NOT NULL, answer_digest TEXT NOT NULL, receipt_json TEXT, created_at TEXT NOT NULL
);
CREATE TRIGGER gjc_questions_identity_immutable BEFORE UPDATE OF question_id,intent_id,snapshot_json,snapshot_digest ON gjc_questions BEGIN SELECT RAISE(ABORT,'immutable gjc question'); END;
CREATE TRIGGER gjc_question_answers_immutable_update BEFORE UPDATE ON gjc_question_answers BEGIN SELECT RAISE(ABORT,'immutable gjc answer'); END;
CREATE TRIGGER gjc_question_answers_immutable_delete BEFORE DELETE ON gjc_question_answers BEGIN SELECT RAISE(ABORT,'immutable gjc answer'); END;
