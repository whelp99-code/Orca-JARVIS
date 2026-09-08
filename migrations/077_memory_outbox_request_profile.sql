-- Distinguish wire profiles before enabling scoped enqueue/dispatch. Existing
-- rows and writers keep their current profile; no authority is granted here.
ALTER TABLE memory_outbox ADD COLUMN request_profile TEXT NOT NULL DEFAULT 'legacy'
  CHECK(request_profile IN ('legacy','scoped-v4'));
CREATE TRIGGER memory_outbox_request_profile_immutable
BEFORE UPDATE OF request_profile ON memory_outbox
BEGIN SELECT RAISE(ABORT,'immutable memory outbox request profile'); END;
CREATE INDEX memory_outbox_profile_state ON memory_outbox(request_profile,state,created_at,outbox_id);
