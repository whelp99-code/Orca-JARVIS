-- The morning entry records when it subscribed to the 07:00 refresh, and the
-- published operating brief the operator reads. First subscription for a date wins.
CREATE TABLE morning_refresh_subscriptions (
  local_date TEXT PRIMARY KEY,
  subscribed_at TEXT NOT NULL
);
CREATE TABLE morning_operating_publications (
  brief_id TEXT PRIMARY KEY,
  operations_json TEXT NOT NULL
);
