CREATE TABLE memory_cancellation_settlements (
  correction_id TEXT PRIMARY KEY REFERENCES memory_correction_cancellation_results(correction_id),
  purge_id TEXT NOT NULL UNIQUE REFERENCES memory_cancellation_compaction_receipts(purge_id),
  result_digest TEXT NOT NULL,
  local_receipt_digest TEXT NOT NULL,
  tombstone_sequence INTEGER NOT NULL UNIQUE REFERENCES memory_tombstone_chain(sequence),
  tombstone_set_root TEXT NOT NULL,
  settled_at TEXT NOT NULL
);
CREATE TRIGGER cancellation_settlement_update BEFORE UPDATE ON memory_cancellation_settlements
BEGIN SELECT RAISE(ABORT,'immutable cancellation settlement'); END;
CREATE TRIGGER cancellation_settlement_delete BEFORE DELETE ON memory_cancellation_settlements
BEGIN SELECT RAISE(ABORT,'immutable cancellation settlement'); END;
CREATE TRIGGER cancellation_settlement_replace BEFORE INSERT ON memory_cancellation_settlements
WHEN EXISTS(SELECT 1 FROM memory_cancellation_settlements WHERE correction_id=NEW.correction_id OR purge_id=NEW.purge_id)
BEGIN SELECT RAISE(ABORT,'immutable cancellation settlement'); END;
CREATE TRIGGER cancellation_settlement_binding BEFORE INSERT ON memory_cancellation_settlements
WHEN NOT EXISTS(
 SELECT 1 FROM memory_correction_cancellation_results p JOIN memory_cancellation_compaction_inputs i ON i.correction_id=p.correction_id
 JOIN memory_cancellation_compaction_receipts r ON r.purge_id=i.purge_id JOIN memory_tombstone_chain t ON t.sequence=NEW.tombstone_sequence
 JOIN memory_effect_dispatch_cursor c ON c.singleton_id=1
 WHERE p.correction_id=NEW.correction_id AND p.result_digest=NEW.result_digest AND i.result_digest=NEW.result_digest
 AND i.purge_id=NEW.purge_id AND r.receipt_digest=NEW.local_receipt_digest AND t.set_root=NEW.tombstone_set_root
 AND json_extract(p.result_json,'$.tombstone_sequence')=NEW.tombstone_sequence
 AND json_extract(p.result_json,'$.tombstone_set_root')=NEW.tombstone_set_root
 AND c.active_lane_id IS NULL AND c.accepted_through_sequence=NEW.tombstone_sequence-1
)
BEGIN SELECT RAISE(ABORT,'cancellation settlement binding invalid'); END;
CREATE TRIGGER cancellation_cursor_idle_advance BEFORE UPDATE ON memory_effect_dispatch_cursor
WHEN OLD.active_lane_id IS NULL AND NEW.active_lane_id IS NULL AND NEW.accepted_through_sequence>OLD.accepted_through_sequence
AND NOT EXISTS(SELECT 1 FROM memory_cancellation_settlements s WHERE s.tombstone_sequence=NEW.accepted_through_sequence
 AND NEW.accepted_through_sequence=OLD.accepted_through_sequence+1)
BEGIN SELECT RAISE(ABORT,'cancellation settlement required'); END;
