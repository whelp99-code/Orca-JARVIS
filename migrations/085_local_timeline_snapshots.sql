-- Disposable local read cache. Historical personal observations remain immutable.
-- Subject rows survive payload expiry so holds cannot be lost through eviction.
CREATE TABLE local_timeline_subjects (
  task_id TEXT PRIMARY KEY NOT NULL CHECK(length(task_id) BETWEEN 1 AND 256),
  generation INTEGER NOT NULL DEFAULT 0 CHECK(generation>=0),
  held INTEGER NOT NULL DEFAULT 0 CHECK(held IN (0,1)),
  snapshot_json TEXT CHECK(snapshot_json IS NULL OR (json_valid(snapshot_json) AND length(CAST(snapshot_json AS BLOB))<=262144)),
  collection_id TEXT UNIQUE,
  expires_at TEXT,
  CHECK((snapshot_json IS NULL AND collection_id IS NULL AND expires_at IS NULL)
    OR (snapshot_json IS NOT NULL AND collection_id IS NOT NULL AND expires_at IS NOT NULL)),
  CHECK(held=0 OR snapshot_json IS NULL)
);
CREATE TRIGGER local_timeline_subject_capacity BEFORE INSERT ON local_timeline_subjects
WHEN (SELECT count(*) FROM local_timeline_subjects)>=64
BEGIN SELECT RAISE(ABORT,'LOCAL_COLLECTION_CAPACITY'); END;
