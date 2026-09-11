-- Which task a memory candidate was derived from.
--
-- The candidate contract names the control command, the verification and the session it came
-- through, but never the task whose work produced it, so a task hidden by its owner could still
-- have a summary of itself read, approved and stored. The binding lives beside the candidate
-- rather than inside it: the candidate's identity, source and content digests are already sealed
-- and re-shaping them would invalidate every stored candidate to add a relation that is not part
-- of what was attested.
--
-- One task per candidate, written once at admission and never rewritten, so a later run cannot
-- point an existing candidate at a different task to make it readable again.
CREATE TABLE memory_candidate_task_sources (
  candidate_id TEXT PRIMARY KEY REFERENCES memory_candidates(candidate_id),
  task_id TEXT NOT NULL CHECK(length(task_id) BETWEEN 1 AND 256),
  recorded_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',recorded_at)=recorded_at)
);
CREATE INDEX memory_candidate_task_sources_task
  ON memory_candidate_task_sources(task_id,candidate_id);

CREATE TRIGGER memory_candidate_task_sources_immutable BEFORE UPDATE
  ON memory_candidate_task_sources
BEGIN SELECT RAISE(ABORT,'immutable memory candidate task source'); END;

CREATE TRIGGER memory_candidate_task_sources_immutable_delete BEFORE DELETE
  ON memory_candidate_task_sources
BEGIN SELECT RAISE(ABORT,'immutable memory candidate task source'); END;
