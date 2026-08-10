-- Coordinator protocol receipts are append-only, schema-bound evidence.
ALTER TABLE gjc_runtime_config ADD COLUMN server_name TEXT;
ALTER TABLE gjc_runtime_config ADD COLUMN server_version TEXT;
CREATE TABLE gjc_dispatch_receipts (
  intent_id TEXT PRIMARY KEY REFERENCES gjc_intents(intent_id), session_id TEXT NOT NULL, turn_id TEXT NOT NULL,
  receipt_json TEXT NOT NULL, accepted_at TEXT NOT NULL
);
CREATE TABLE gjc_answer_receipts (
  intent_id TEXT PRIMARY KEY REFERENCES gjc_intents(intent_id), session_id TEXT NOT NULL, turn_id TEXT NOT NULL,
  question_id TEXT NOT NULL, answer_binding_json TEXT NOT NULL, receipt_json TEXT NOT NULL, completed_at TEXT NOT NULL
);
CREATE TRIGGER gjc_dispatch_receipts_immutable_update BEFORE UPDATE ON gjc_dispatch_receipts BEGIN SELECT RAISE(ABORT,'immutable gjc dispatch receipt'); END;
CREATE TRIGGER gjc_answer_receipts_immutable_update BEFORE UPDATE ON gjc_answer_receipts BEGIN SELECT RAISE(ABORT,'immutable gjc answer receipt'); END;
