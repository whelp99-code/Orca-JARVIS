-- Monotonic revision for read-side privacy snapshots. No memory/approval authority is issued.
CREATE TABLE memory_read_revision (
  singleton_id INTEGER PRIMARY KEY CHECK(singleton_id=1),
  revision INTEGER NOT NULL CHECK(typeof(revision)='integer' AND revision>=0)
);
INSERT INTO memory_read_revision VALUES(1,0);
CREATE TRIGGER memory_read_revision_insert_guard BEFORE INSERT ON memory_read_revision
WHEN EXISTS(SELECT 1 FROM memory_read_revision)
BEGIN SELECT RAISE(ABORT,'memory read revision already exists'); END;
CREATE TRIGGER memory_read_revision_update_guard BEFORE UPDATE ON memory_read_revision
WHEN NEW.singleton_id!=OLD.singleton_id OR NEW.revision!=OLD.revision+1
BEGIN SELECT RAISE(ABORT,'memory read revision must advance'); END;
CREATE TRIGGER memory_read_revision_delete_guard BEFORE DELETE ON memory_read_revision
BEGIN SELECT RAISE(ABORT,'immutable memory read revision'); END;

CREATE TRIGGER memory_read_revision_memory_surface_authority_insert AFTER INSERT ON memory_surface_authority
BEGIN UPDATE memory_read_revision SET revision=revision+1 WHERE singleton_id=1; END;

CREATE TRIGGER memory_read_revision_memory_surface_authority_update AFTER UPDATE ON memory_surface_authority
BEGIN UPDATE memory_read_revision SET revision=revision+1 WHERE singleton_id=1; END;

CREATE TRIGGER memory_read_revision_memory_surface_authority_delete AFTER DELETE ON memory_surface_authority
BEGIN UPDATE memory_read_revision SET revision=revision+1 WHERE singleton_id=1; END;

CREATE TRIGGER memory_read_revision_memory_surface_target_versions_insert AFTER INSERT ON memory_surface_target_versions
BEGIN UPDATE memory_read_revision SET revision=revision+1 WHERE singleton_id=1; END;

CREATE TRIGGER memory_read_revision_memory_surface_target_versions_update AFTER UPDATE ON memory_surface_target_versions
BEGIN UPDATE memory_read_revision SET revision=revision+1 WHERE singleton_id=1; END;

CREATE TRIGGER memory_read_revision_memory_surface_target_versions_delete AFTER DELETE ON memory_surface_target_versions
BEGIN UPDATE memory_read_revision SET revision=revision+1 WHERE singleton_id=1; END;

CREATE TRIGGER memory_read_revision_memory_surface_suppressions_insert AFTER INSERT ON memory_surface_suppressions
BEGIN UPDATE memory_read_revision SET revision=revision+1 WHERE singleton_id=1; END;

CREATE TRIGGER memory_read_revision_memory_surface_suppressions_update AFTER UPDATE ON memory_surface_suppressions
BEGIN UPDATE memory_read_revision SET revision=revision+1 WHERE singleton_id=1; END;

CREATE TRIGGER memory_read_revision_memory_surface_suppressions_delete AFTER DELETE ON memory_surface_suppressions
BEGIN UPDATE memory_read_revision SET revision=revision+1 WHERE singleton_id=1; END;

CREATE TRIGGER memory_read_revision_memory_suppressions_insert AFTER INSERT ON memory_suppressions
BEGIN UPDATE memory_read_revision SET revision=revision+1 WHERE singleton_id=1; END;

CREATE TRIGGER memory_read_revision_memory_suppressions_update AFTER UPDATE ON memory_suppressions
BEGIN UPDATE memory_read_revision SET revision=revision+1 WHERE singleton_id=1; END;

CREATE TRIGGER memory_read_revision_memory_suppressions_delete AFTER DELETE ON memory_suppressions
BEGIN UPDATE memory_read_revision SET revision=revision+1 WHERE singleton_id=1; END;

CREATE TRIGGER memory_read_revision_memory_effect_delegation_keys_insert AFTER INSERT ON memory_effect_delegation_keys
BEGIN UPDATE memory_read_revision SET revision=revision+1 WHERE singleton_id=1; END;

CREATE TRIGGER memory_read_revision_memory_effect_delegation_keys_update AFTER UPDATE ON memory_effect_delegation_keys
BEGIN UPDATE memory_read_revision SET revision=revision+1 WHERE singleton_id=1; END;

CREATE TRIGGER memory_read_revision_memory_effect_delegation_keys_delete AFTER DELETE ON memory_effect_delegation_keys
BEGIN UPDATE memory_read_revision SET revision=revision+1 WHERE singleton_id=1; END;

CREATE TRIGGER memory_read_revision_memory_effect_delegation_revocations_insert AFTER INSERT ON memory_effect_delegation_revocations
BEGIN UPDATE memory_read_revision SET revision=revision+1 WHERE singleton_id=1; END;

CREATE TRIGGER memory_read_revision_memory_effect_delegation_revocations_update AFTER UPDATE ON memory_effect_delegation_revocations
BEGIN UPDATE memory_read_revision SET revision=revision+1 WHERE singleton_id=1; END;

CREATE TRIGGER memory_read_revision_memory_effect_delegation_revocations_delete AFTER DELETE ON memory_effect_delegation_revocations
BEGIN UPDATE memory_read_revision SET revision=revision+1 WHERE singleton_id=1; END;
