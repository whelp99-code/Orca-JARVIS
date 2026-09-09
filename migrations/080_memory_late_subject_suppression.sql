-- Repair subject-linked projections bound after the original tombstone event.
-- Preserve the original dependency, suppression and event identities verbatim.
INSERT OR IGNORE INTO memory_projection_suppressions(
  sequence,projection_kind,projection_id,component_id,suppression_id,effective_at
)
SELECT s.sequence,d.projection_kind,d.projection_id,d.component_id,s.suppression_id,s.effective_at
FROM memory_suppressions s JOIN memory_projection_dependencies d
  ON d.keyed_subject_digest=s.keyed_subject_digest
WHERE s.state='active' AND d.keyed_subject_digest IS NOT NULL;
