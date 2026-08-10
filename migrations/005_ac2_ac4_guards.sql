ALTER TABLE work_items ADD COLUMN expected_effect TEXT NOT NULL DEFAULT 'shadow_mock_only';
ALTER TABLE work_items ADD COLUMN reversible INTEGER NOT NULL DEFAULT 1 CHECK(reversible IN (0,1));
ALTER TABLE work_items ADD COLUMN tokens_used INTEGER NOT NULL DEFAULT 0 CHECK(tokens_used >= 0);
CREATE UNIQUE INDEX outbox_one_kind_per_continuation ON outbox(continuation_id, kind);
CREATE TRIGGER outbox_allowed_kind_insert BEFORE INSERT ON outbox WHEN NEW.kind NOT IN ('seed_mock','dispatch_mock') BEGIN SELECT RAISE(ABORT, 'invalid mock outbox kind'); END;
CREATE TRIGGER outbox_allowed_kind_update BEFORE UPDATE OF kind ON outbox WHEN NEW.kind NOT IN ('seed_mock','dispatch_mock') BEGIN SELECT RAISE(ABORT, 'invalid mock outbox kind'); END;
