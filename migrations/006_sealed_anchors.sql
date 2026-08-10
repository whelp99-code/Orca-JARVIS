CREATE TABLE IF NOT EXISTS authority_configuration (id INTEGER PRIMARY KEY CHECK(id=1), sealed_at TEXT NOT NULL);
CREATE TRIGGER trusted_keys_sealed_insert BEFORE INSERT ON trusted_authority_keys WHEN EXISTS(SELECT 1 FROM authority_configuration WHERE id=1) BEGIN SELECT RAISE(ABORT, 'authority anchors sealed'); END;
CREATE TRIGGER trusted_keys_sealed_update BEFORE UPDATE ON trusted_authority_keys WHEN EXISTS(SELECT 1 FROM authority_configuration WHERE id=1) BEGIN SELECT RAISE(ABORT, 'authority anchors sealed'); END;
CREATE TRIGGER trusted_keys_sealed_delete BEFORE DELETE ON trusted_authority_keys WHEN EXISTS(SELECT 1 FROM authority_configuration WHERE id=1) BEGIN SELECT RAISE(ABORT, 'authority anchors sealed'); END;
