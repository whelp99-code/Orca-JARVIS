CREATE TABLE company_candidate_handoffs (
  request_id TEXT PRIMARY KEY REFERENCES control_command_requests(request_id),
  idempotency_key TEXT NOT NULL,
  generation INTEGER NOT NULL CHECK(generation > 0),
  command_digest TEXT NOT NULL,
  context_json TEXT NOT NULL,
  current INTEGER NOT NULL DEFAULT 1 CHECK(current IN (0,1)),
  status TEXT NOT NULL DEFAULT 'imported'
    CHECK(status IN ('imported','invoking','accepted','verifying','completing','completed','rejected','uncertain','superseded')),
  lease_token TEXT,
  lease_expires_at TEXT,
  completion_json TEXT,
  failure_code TEXT,
  imported_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(idempotency_key,generation)
);
CREATE UNIQUE INDEX company_candidate_current ON company_candidate_handoffs(idempotency_key) WHERE current=1;
CREATE TABLE company_candidate_sb_receipts (
  request_id TEXT NOT NULL REFERENCES company_candidate_handoffs(request_id),
  operation TEXT NOT NULL CHECK(operation IN ('accept','reject','mark_processed')),
  receipt_id TEXT NOT NULL UNIQUE,
  receipt_digest TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  PRIMARY KEY(request_id,operation)
);
CREATE TRIGGER company_handoff_identity_immutable BEFORE UPDATE OF
  request_id,idempotency_key,generation,command_digest,context_json,imported_at
  ON company_candidate_handoffs BEGIN SELECT RAISE(ABORT,'immutable company handoff identity'); END;
CREATE TRIGGER company_handoff_completion_immutable BEFORE UPDATE OF completion_json
  ON company_candidate_handoffs WHEN OLD.completion_json IS NOT NULL
  BEGIN SELECT RAISE(ABORT,'immutable company completion evidence'); END;
CREATE TRIGGER company_sb_receipt_update_immutable BEFORE UPDATE ON company_candidate_sb_receipts
  BEGIN SELECT RAISE(ABORT,'immutable company SB receipt'); END;
CREATE TRIGGER company_sb_receipt_delete_immutable BEFORE DELETE ON company_candidate_sb_receipts
  BEGIN SELECT RAISE(ABORT,'immutable company SB receipt'); END;
