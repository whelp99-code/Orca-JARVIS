CREATE TABLE memory_outbox_not_delivered (
  outbox_id TEXT PRIMARY KEY REFERENCES memory_outbox(outbox_id),
  state TEXT NOT NULL CHECK(state='abandoned_not_delivered'),
  attempt_id TEXT NOT NULL,
  outcome_code TEXT NOT NULL,
  action_request_id TEXT NOT NULL,
  receipt_digest TEXT NOT NULL,
  closed_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',closed_at)=closed_at),
  created_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',created_at)=created_at)
);
CREATE TRIGGER memory_outbox_not_delivered_immutable
BEFORE UPDATE ON memory_outbox_not_delivered
BEGIN
  SELECT RAISE(ABORT,'memory outbox not-delivered row is immutable');
END;
CREATE TRIGGER memory_outbox_not_delivered_no_delete
BEFORE DELETE ON memory_outbox_not_delivered
BEGIN
  SELECT RAISE(ABORT,'memory outbox not-delivered row is immutable');
END;

CREATE TABLE memory_outbox_not_delivered_events (
  event_id TEXT PRIMARY KEY,
  outbox_id TEXT NOT NULL REFERENCES memory_outbox_not_delivered(outbox_id),
  event_type TEXT NOT NULL CHECK(event_type='abandoned_not_delivered'),
  outcome_code TEXT NOT NULL,
  receipt_digest TEXT NOT NULL,
  created_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',created_at)=created_at)
);
CREATE TRIGGER memory_outbox_not_delivered_events_immutable
BEFORE UPDATE ON memory_outbox_not_delivered_events
BEGIN
  SELECT RAISE(ABORT,'memory outbox not-delivered event is immutable');
END;
