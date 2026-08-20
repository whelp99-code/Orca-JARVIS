CREATE TABLE dashboard_portfolio_projection (
  environment TEXT NOT NULL PRIMARY KEY CHECK(environment IN ('local','jm-server')),
  producer TEXT NOT NULL CHECK(
    (environment = 'local' AND producer = 'jarvis-local')
    OR (environment = 'jm-server' AND producer = 'jarvis-jm-server')
  ),
  last_reported_at TEXT NOT NULL,
  last_received_at TEXT NOT NULL,
  report_digest TEXT NOT NULL,
  collector_status TEXT NOT NULL CHECK(collector_status IN ('ok','error')),
  collector_error TEXT,
  last_success_snapshot_json TEXT,
  last_success_digest TEXT,
  CHECK(
    (collector_status = 'ok' AND collector_error IS NULL AND last_success_snapshot_json IS NOT NULL AND last_success_digest IS NOT NULL)
    OR
    (collector_status = 'error' AND collector_error IS NOT NULL AND (
      (last_success_snapshot_json IS NULL AND last_success_digest IS NULL)
      OR (last_success_snapshot_json IS NOT NULL AND last_success_digest IS NOT NULL)
    ))
  )
);
