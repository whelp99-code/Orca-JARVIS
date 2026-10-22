CREATE TABLE company_decision_reservation_acks (
  operation_id TEXT PRIMARY KEY REFERENCES company_progress_reservations(operation_id),
  response_json TEXT NOT NULL,
  received_at TEXT NOT NULL
);
CREATE TRIGGER company_decision_reservation_acks_no_update BEFORE UPDATE ON company_decision_reservation_acks
BEGIN SELECT RAISE(ABORT, 'company reservation acknowledgements are immutable'); END;
CREATE TRIGGER company_decision_reservation_acks_no_delete BEFORE DELETE ON company_decision_reservation_acks
BEGIN SELECT RAISE(ABORT, 'company reservation acknowledgements are immutable'); END;

CREATE TABLE company_progress_intent_refusals (
  operation_id TEXT PRIMARY KEY,
  response_json TEXT NOT NULL,
  received_at TEXT NOT NULL
);
CREATE TRIGGER company_progress_intent_refusals_no_update BEFORE UPDATE ON company_progress_intent_refusals
BEGIN SELECT RAISE(ABORT, 'company intent refusals are immutable'); END;
CREATE TRIGGER company_progress_intent_refusals_no_delete BEFORE DELETE ON company_progress_intent_refusals
BEGIN SELECT RAISE(ABORT, 'company intent refusals are immutable'); END;

CREATE TABLE company_progress_cancellation_outbox (
  operation_id TEXT PRIMARY KEY,
  evidence_kind TEXT NOT NULL CHECK(evidence_kind='jarvis_cancellation'),
  evidence_json TEXT NOT NULL,
  evidence_digest TEXT NOT NULL,
  acknowledged INTEGER NOT NULL DEFAULT 0 CHECK(acknowledged IN (0,1))
);
CREATE TRIGGER company_progress_cancellation_no_rewrite BEFORE UPDATE ON company_progress_cancellation_outbox
WHEN NEW.operation_id<>OLD.operation_id OR NEW.evidence_kind<>OLD.evidence_kind
  OR NEW.evidence_json<>OLD.evidence_json OR NEW.evidence_digest<>OLD.evidence_digest
  OR NEW.acknowledged<OLD.acknowledged
BEGIN SELECT RAISE(ABORT, 'company cancellation evidence is immutable'); END;
CREATE TRIGGER company_progress_cancellation_no_delete BEFORE DELETE ON company_progress_cancellation_outbox
BEGIN SELECT RAISE(ABORT, 'company cancellation evidence is immutable'); END;
