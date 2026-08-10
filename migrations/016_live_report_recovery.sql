-- A live report is the durable delivery envelope for the two internal reports
-- created while a signed candidate is staged.  The links are append-only so a
-- live acknowledgement can settle exactly the reports it emitted.
CREATE TABLE live_supervisor_candidate_report_sources (
  candidate_id TEXT PRIMARY KEY REFERENCES pre_gjc_candidates(candidate_id),
  progress_report_id TEXT REFERENCES progress_report_outbox(report_id),
  pre_gjc_report_id TEXT NOT NULL REFERENCES pre_gjc_report_outbox(report_id),
  created_at TEXT NOT NULL
);
CREATE TABLE live_supervisor_report_sources (
  report_id TEXT NOT NULL REFERENCES live_supervisor_reports(report_id),
  candidate_id TEXT NOT NULL UNIQUE REFERENCES live_supervisor_candidate_report_sources(candidate_id),
  progress_report_id TEXT REFERENCES progress_report_outbox(report_id),
  pre_gjc_report_id TEXT NOT NULL REFERENCES pre_gjc_report_outbox(report_id),
  PRIMARY KEY(report_id,candidate_id)
);
CREATE TRIGGER live_supervisor_candidate_report_sources_immutable_update BEFORE UPDATE ON live_supervisor_candidate_report_sources BEGIN SELECT RAISE(ABORT,'immutable live candidate report source'); END;
CREATE TRIGGER live_supervisor_candidate_report_sources_immutable_delete BEFORE DELETE ON live_supervisor_candidate_report_sources BEGIN SELECT RAISE(ABORT,'immutable live candidate report source'); END;
CREATE TRIGGER live_supervisor_report_sources_immutable_update BEFORE UPDATE ON live_supervisor_report_sources BEGIN SELECT RAISE(ABORT,'immutable live report source'); END;
CREATE TRIGGER live_supervisor_report_sources_immutable_delete BEFORE DELETE ON live_supervisor_report_sources BEGIN SELECT RAISE(ABORT,'immutable live report source'); END;

-- Live resume policy is bound to one exact runtime target.  Existing databases
-- get NULL legacy columns and cannot be considered live-resume configured.
ALTER TABLE live_supervisor_live_resume_config ADD COLUMN canonical_path TEXT;
ALTER TABLE live_supervisor_live_resume_config ADD COLUMN provider TEXT;
ALTER TABLE live_supervisor_live_resume_config ADD COLUMN terminal_id TEXT;
ALTER TABLE live_supervisor_live_resume_config ADD COLUMN session_id TEXT;
ALTER TABLE live_supervisor_live_resume_config ADD COLUMN incarnation_id TEXT;
ALTER TABLE live_supervisor_live_resume_config ADD COLUMN pty_id TEXT;
ALTER TABLE live_supervisor_live_resume_config ADD COLUMN worktree_id TEXT;
ALTER TABLE live_supervisor_live_resume_config_audit ADD COLUMN canonical_path TEXT;
ALTER TABLE live_supervisor_live_resume_config_audit ADD COLUMN provider TEXT;
ALTER TABLE live_supervisor_live_resume_config_audit ADD COLUMN terminal_id TEXT;
ALTER TABLE live_supervisor_live_resume_config_audit ADD COLUMN session_id TEXT;
ALTER TABLE live_supervisor_live_resume_config_audit ADD COLUMN incarnation_id TEXT;
ALTER TABLE live_supervisor_live_resume_config_audit ADD COLUMN pty_id TEXT;
ALTER TABLE live_supervisor_live_resume_config_audit ADD COLUMN worktree_id TEXT;

-- Carry the authority kind into the immutable human intent, rather than
-- inferring it from a terminal or a mutable request later.
ALTER TABLE pre_gjc_resume_intents ADD COLUMN authority_kind TEXT NOT NULL DEFAULT 'legacy' CHECK(authority_kind IN ('legacy','approval_required','needs_input'));
CREATE TRIGGER pre_gjc_resume_intents_authority_kind_immutable BEFORE UPDATE OF authority_kind ON pre_gjc_resume_intents BEGIN SELECT RAISE(ABORT,'immutable resume authority kind'); END;
