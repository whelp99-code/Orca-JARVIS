-- Last first-cycle observation, bound to one exact GJC lease incarnation.
-- This is diagnostic state; it does not grant execution or deployment authority.
CREATE TABLE gjc_runtime_identity (
  id INTEGER PRIMARY KEY CHECK(id=1),
  lease_owner TEXT NOT NULL,
  lease_fence INTEGER NOT NULL CHECK(lease_fence>0),
  snapshot_json TEXT NOT NULL CHECK(length(CAST(snapshot_json AS BLOB)) <= 8192),
  recorded_at TEXT NOT NULL
);
