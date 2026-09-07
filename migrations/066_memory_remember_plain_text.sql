-- Explicit V3 remember publications. Preserve every V1/V2 row and immutable identity.
CREATE TABLE memory_candidate_dispatch_publications_v3 (
  candidate_id TEXT PRIMARY KEY REFERENCES memory_candidates(candidate_id),
  schema_version INTEGER NOT NULL CHECK(schema_version IN (1,2,3)),
  operation TEXT NOT NULL CHECK(operation IN ('remember','correct')),
  dispatch_spool_digest TEXT NOT NULL UNIQUE,
  target_version_digest TEXT,
  expected_prior_digest TEXT,
  scope_digest TEXT,
  state TEXT NOT NULL CHECK(state IN ('published','accepted','terminal')),
  published_at TEXT NOT NULL,
  accepted_at TEXT,
  terminal_at TEXT,
  CHECK((operation='remember' AND schema_version IN (1,3) AND target_version_digest IS NULL)
    OR (operation='correct' AND schema_version=2 AND target_version_digest IS NOT NULL))
);

INSERT INTO memory_candidate_dispatch_publications_v3 SELECT * FROM memory_candidate_dispatch_publications;
DROP TABLE memory_candidate_dispatch_publications;
ALTER TABLE memory_candidate_dispatch_publications_v3 RENAME TO memory_candidate_dispatch_publications;
CREATE TRIGGER memory_dispatch_identity_immutable BEFORE UPDATE OF candidate_id,schema_version,operation,
  dispatch_spool_digest,target_version_digest,expected_prior_digest,scope_digest,published_at
ON memory_candidate_dispatch_publications
BEGIN SELECT RAISE(ABORT,'immutable memory candidate dispatch identity'); END;
