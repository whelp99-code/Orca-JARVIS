CREATE TABLE memory_cancellation_compaction_inputs (
  purge_id TEXT PRIMARY KEY REFERENCES memory_purge_jobs(purge_id),
  correction_id TEXT NOT NULL UNIQUE REFERENCES memory_correction_cancellation_results(correction_id),
  result_digest TEXT NOT NULL,
  layout_json TEXT NOT NULL CHECK(json_valid(layout_json)),
  created_at TEXT NOT NULL
);
CREATE TABLE memory_cancellation_compaction_receipts (
  purge_id TEXT PRIMARY KEY REFERENCES memory_cancellation_compaction_inputs(purge_id),
  receipt_digest TEXT NOT NULL UNIQUE,
  receipt_json TEXT NOT NULL CHECK(json_valid(receipt_json)),
  created_at TEXT NOT NULL
);
CREATE TRIGGER cancellation_compaction_input_update BEFORE UPDATE ON memory_cancellation_compaction_inputs
BEGIN SELECT RAISE(ABORT,'immutable cancellation compaction input'); END;
CREATE TRIGGER cancellation_compaction_input_delete BEFORE DELETE ON memory_cancellation_compaction_inputs
BEGIN SELECT RAISE(ABORT,'immutable cancellation compaction input'); END;
CREATE TRIGGER cancellation_compaction_input_replace BEFORE INSERT ON memory_cancellation_compaction_inputs
WHEN EXISTS(SELECT 1 FROM memory_cancellation_compaction_inputs WHERE purge_id=NEW.purge_id OR correction_id=NEW.correction_id)
BEGIN SELECT RAISE(ABORT,'immutable cancellation compaction input'); END;
CREATE TRIGGER cancellation_compaction_receipt_update BEFORE UPDATE ON memory_cancellation_compaction_receipts
BEGIN SELECT RAISE(ABORT,'immutable cancellation compaction receipt'); END;
CREATE TRIGGER cancellation_compaction_receipt_delete BEFORE DELETE ON memory_cancellation_compaction_receipts
BEGIN SELECT RAISE(ABORT,'immutable cancellation compaction receipt'); END;
CREATE TRIGGER cancellation_compaction_receipt_replace BEFORE INSERT ON memory_cancellation_compaction_receipts
WHEN EXISTS(SELECT 1 FROM memory_cancellation_compaction_receipts WHERE purge_id=NEW.purge_id)
BEGIN SELECT RAISE(ABORT,'immutable cancellation compaction receipt'); END;
