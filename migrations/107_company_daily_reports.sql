CREATE TABLE company_daily_reports (
  report_id TEXT PRIMARY KEY,
  provider TEXT NOT NULL CHECK(length(provider) BETWEEN 1 AND 128),
  workspace TEXT NOT NULL CHECK(length(workspace) BETWEEN 1 AND 128),
  report_date TEXT NOT NULL CHECK(strftime('%Y-%m-%d', report_date) = report_date),
  cutoff_from TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ', cutoff_from) = cutoff_from),
  cutoff_to TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ', cutoff_to) = cutoff_to),
  report_digest TEXT NOT NULL CHECK(report_digest GLOB 'sha256:[0-9a-f][0-9a-f][0-9a-f][0-9a-f]*' AND length(report_digest) = 71),
  report_json TEXT NOT NULL CHECK(length(report_json) BETWEEN 2 AND 2000000),
  published_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ', published_at) = published_at),
  UNIQUE(provider, workspace, report_date),
  CHECK(julianday(cutoff_to) >= julianday(cutoff_from))
);
CREATE TABLE company_report_notifications (
  report_id TEXT PRIMARY KEY REFERENCES company_daily_reports(report_id),
  intent_id TEXT NOT NULL UNIQUE REFERENCES notification_intents(intent_id),
  state TEXT NOT NULL CHECK(state IN ('pending', 'unsupported', 'delivered', 'failed')),
  delivery_receipt TEXT
);
CREATE TRIGGER company_daily_reports_identity_immutable BEFORE UPDATE OF
  report_id, provider, workspace, report_date, cutoff_from, cutoff_to, report_digest, report_json, published_at
  ON company_daily_reports
  BEGIN SELECT RAISE(ABORT, 'immutable company daily report'); END;
CREATE TRIGGER company_daily_reports_delete_immutable BEFORE DELETE ON company_daily_reports
  BEGIN SELECT RAISE(ABORT, 'immutable company daily report'); END;
CREATE TRIGGER company_report_notifications_identity_immutable BEFORE UPDATE OF report_id, intent_id
  ON company_report_notifications
  BEGIN SELECT RAISE(ABORT, 'immutable company report notification'); END;
CREATE TRIGGER company_report_notifications_delete_immutable BEFORE DELETE ON company_report_notifications
  BEGIN SELECT RAISE(ABORT, 'immutable company report notification'); END;
