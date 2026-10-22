-- Preserve the original signed decision before provider I/O, outside receipt publication.
CREATE TABLE company_decision_receipt_intents (
  request_id TEXT PRIMARY KEY REFERENCES control_command_requests(request_id),
  receipt_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
