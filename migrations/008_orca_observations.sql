CREATE TABLE IF NOT EXISTS orca_observation_sources (
  worktree_selector TEXT NOT NULL,
  terminal_handle TEXT NOT NULL,
  provider TEXT NOT NULL CHECK(provider IN ('codex','claude')),
  incarnation_id TEXT NOT NULL,
  next_cursor TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(worktree_selector,terminal_handle)
);
CREATE TABLE IF NOT EXISTS orca_observation_deltas (
  identity TEXT PRIMARY KEY,
  worktree_selector TEXT NOT NULL,
  terminal_handle TEXT NOT NULL,
  provider TEXT NOT NULL CHECK(provider IN ('codex','claude')),
  incarnation_id TEXT NOT NULL,
  cursor_before TEXT,
  cursor_after TEXT,
  tail_json TEXT NOT NULL,
  digest TEXT NOT NULL,
  truncated INTEGER NOT NULL CHECK(truncated IN (0,1)),
  limited INTEGER NOT NULL CHECK(limited IN (0,1)),
  oldest_cursor TEXT,
  latest_cursor TEXT,
  returned_line_count INTEGER NOT NULL CHECK(returned_line_count >= 0),
  observed_at TEXT NOT NULL
);
CREATE TRIGGER immutable_orca_observation_delta_update BEFORE UPDATE ON orca_observation_deltas BEGIN SELECT RAISE(ABORT, 'immutable orca observation delta'); END;
CREATE TRIGGER immutable_orca_observation_delta_delete BEFORE DELETE ON orca_observation_deltas BEGIN SELECT RAISE(ABORT, 'immutable orca observation delta'); END;
