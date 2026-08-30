-- Terminal Work Memory and workflow correlation, forward-only after immutable 033.

ALTER TABLE memory_outbox
  ADD COLUMN expected_artifact_selector TEXT NOT NULL DEFAULT 'selector:legacy';
ALTER TABLE memory_outbox
  ADD COLUMN provider_version TEXT NOT NULL DEFAULT 'legacy';
ALTER TABLE memory_outbox
  ADD COLUMN provider_artifact_digest TEXT CHECK(
    provider_artifact_digest IS NULL OR (
      length(provider_artifact_digest)=71
      AND substr(provider_artifact_digest,1,7)='sha256:'
      AND substr(provider_artifact_digest,8) NOT GLOB '*[^0-9a-f]*'
    )
  );
ALTER TABLE memory_outbox
  ADD COLUMN provider_page_id TEXT CHECK(
    provider_page_id IS NULL OR length(provider_page_id) BETWEEN 1 AND 512
  );
ALTER TABLE memory_outbox
  ADD COLUMN provider_status TEXT CHECK(
    provider_status IS NULL OR provider_status IN (
      'accepted','applied','forgotten','exported','restored','settled'
    )
  );

DROP TRIGGER memory_outbox_transition;
CREATE TRIGGER memory_outbox_transition
BEFORE UPDATE OF state ON memory_outbox
WHEN OLD.state<>NEW.state AND OLD.state||':'||NEW.state NOT IN (
  'queued:delivering',
  'queued:uncertain',
  'queued:expired',
  'delivering:accepted_unsettled',
  'delivering:rejected',
  'delivering:uncertain',
  'delivering:expired',
  'accepted_unsettled:settled',
  'accepted_unsettled:uncertain',
  'accepted_unsettled:expired'
)
BEGIN
  SELECT RAISE(ABORT,'memory outbox transition invalid');
END;

CREATE TRIGGER memory_outbox_provider_identity_immutable
BEFORE UPDATE OF expected_artifact_selector,provider_version ON memory_outbox
BEGIN
  SELECT RAISE(ABORT,'immutable memory outbox provider identity');
END;

CREATE TRIGGER memory_outbox_provider_binding_insert
BEFORE INSERT ON memory_outbox
WHEN NEW.provider_artifact_digest IS NOT NULL
  OR NEW.provider_page_id IS NOT NULL
  OR NEW.provider_status IS NOT NULL
BEGIN
  SELECT RAISE(ABORT,'memory outbox provider binding must start empty');
END;

CREATE TRIGGER memory_outbox_provider_binding_guard
BEFORE UPDATE OF provider_artifact_digest,provider_page_id,provider_status ON memory_outbox
WHEN NOT (
  OLD.provider_artifact_digest IS NULL
  AND OLD.provider_page_id IS NULL
  AND OLD.provider_status IS NULL
  AND NEW.provider_artifact_digest IS NOT NULL
  AND NEW.provider_page_id IS NOT NULL
  AND NEW.provider_status IS NOT NULL
  AND OLD.state IN ('delivering','accepted_unsettled')
  AND NEW.state IN ('accepted_unsettled','uncertain')
  AND OLD.lease_owner IS NOT NULL
  AND OLD.lease_fence>0
  AND NEW.lease_fence=OLD.lease_fence
  AND julianday(NEW.updated_at)<julianday(OLD.lease_expires_at)
  AND julianday(NEW.updated_at)<julianday(OLD.expires_at)
)
BEGIN
  SELECT RAISE(ABORT,'memory outbox provider binding invalid');
END;

CREATE TRIGGER memory_outbox_provider_receipt_required
BEFORE UPDATE OF state ON memory_outbox
WHEN NEW.state='accepted_unsettled' AND NEW.provider_version<>'legacy' AND (
  NEW.provider_artifact_digest IS NULL
  OR NEW.provider_page_id IS NULL
  OR NEW.provider_status IS NULL
)
BEGIN
  SELECT RAISE(ABORT,'memory outbox provider receipt required');
END;

DROP TRIGGER memory_outbox_settlement_guard;
CREATE TRIGGER memory_outbox_settlement_guard
BEFORE UPDATE OF state ON memory_outbox
WHEN OLD.state='accepted_unsettled' AND NEW.state='settled' AND NOT EXISTS (
  SELECT 1 FROM memory_reconciliation_events
  WHERE outbox_id=OLD.outbox_id
    AND lease_fence=OLD.lease_fence
    AND event_type='artifact_observed'
    AND observed_artifact_digest=COALESCE(
      OLD.provider_artifact_digest,
      OLD.expected_artifact_digest
    )
)
BEGIN
  SELECT RAISE(ABORT,'memory outbox reconciliation required');
END;

CREATE TABLE terminal_operation_audit_events (
  event_id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  subject_kind TEXT NOT NULL CHECK(subject_kind IN (
    'terminal_session','terminal_segment','terminal_event','terminal_agent_session',
    'terminal_failure','terminal_resolution','terminal_closeout','terminal_checkpoint',
    'terminal_improvement','workflow_correlation'
  )),
  subject_id TEXT NOT NULL,
  principal_id TEXT,
  correlation_id TEXT NOT NULL,
  causation_id TEXT,
  event_digest TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL CHECK(
    strftime('%Y-%m-%dT%H:%M:%fZ',created_at) IS NOT NULL
    AND strftime('%Y-%m-%dT%H:%M:%fZ',created_at)=created_at
  )
);
CREATE INDEX terminal_operation_audit_subject
  ON terminal_operation_audit_events(subject_kind,subject_id,created_at,event_id);
CREATE INDEX terminal_operation_audit_correlation
  ON terminal_operation_audit_events(correlation_id,created_at,event_id);
CREATE TRIGGER terminal_operation_audit_immutable_update
BEFORE UPDATE ON terminal_operation_audit_events
BEGIN SELECT RAISE(ABORT,'immutable terminal operation audit'); END;
CREATE TRIGGER terminal_operation_audit_immutable_delete
BEFORE DELETE ON terminal_operation_audit_events
BEGIN SELECT RAISE(ABORT,'immutable terminal operation audit'); END;

CREATE TABLE terminal_sessions (
  terminal_id TEXT NOT NULL,
  terminal_incarnation_id TEXT NOT NULL,
  host_id TEXT NOT NULL CHECK(host_id IN ('host:pos:linux-control-plane','host:pos:linux-second-brain','host:pos:mac-client','host:pos:phone-client')),
  environment_id TEXT NOT NULL,
  terminal_provider TEXT NOT NULL CHECK(length(terminal_provider) BETWEEN 1 AND 64),
  started_at TEXT NOT NULL,
  ended_at TEXT,
  status TEXT NOT NULL CHECK(status IN ('active','ended','unknown')),
  primary_project_id TEXT,
  created_by TEXT NOT NULL,
  correlation_id TEXT NOT NULL,
  PRIMARY KEY(terminal_id,terminal_incarnation_id),
  UNIQUE(correlation_id)
);
CREATE INDEX terminal_sessions_status ON terminal_sessions(status,started_at,terminal_id);

CREATE TABLE terminal_project_segments (
  segment_id TEXT PRIMARY KEY,
  terminal_id TEXT NOT NULL,
  terminal_incarnation_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  worktree_id TEXT,
  cwd_digest TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  resolution_source TEXT NOT NULL CHECK(resolution_source IN ('task','dispatch','worktree','worker','git_remote','cwd','unassigned')),
  resolution_confidence TEXT NOT NULL CHECK(resolution_confidence IN ('confirmed','high','medium','low')),
  FOREIGN KEY(terminal_id,terminal_incarnation_id) REFERENCES terminal_sessions(terminal_id,terminal_incarnation_id)
);
CREATE INDEX terminal_segments_lookup ON terminal_project_segments(terminal_id,started_at,segment_id);

CREATE TABLE terminal_events (
  event_id TEXT PRIMARY KEY,
  terminal_id TEXT NOT NULL,
  terminal_incarnation_id TEXT NOT NULL,
  sequence INTEGER NOT NULL CHECK(sequence>0),
  kind TEXT NOT NULL CHECK(kind IN ('command','test','build','git','agent','lifecycle','checkpoint')),
  occurred_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  duration_ms INTEGER CHECK(duration_ms IS NULL OR duration_ms>=0),
  exit_code INTEGER,
  outcome TEXT NOT NULL CHECK(outcome IN ('succeeded','failed','cancelled','timeout','uncertain','skipped')),
  command_class TEXT NOT NULL CHECK(length(command_class) BETWEEN 1 AND 64),
  command_digest TEXT NOT NULL,
  stdout_digest TEXT,
  stderr_digest TEXT,
  evidence_ref TEXT,
  redaction_state TEXT NOT NULL CHECK(redaction_state IN ('redacted','digest_only')),
  correlation_id TEXT NOT NULL,
  UNIQUE(terminal_id,terminal_incarnation_id,sequence),
  FOREIGN KEY(terminal_id,terminal_incarnation_id) REFERENCES terminal_sessions(terminal_id,terminal_incarnation_id)
);
CREATE INDEX terminal_events_time ON terminal_events(terminal_id,occurred_at,event_id);

CREATE TABLE terminal_agent_sessions (
  agent_session_link_id TEXT PRIMARY KEY,
  terminal_id TEXT NOT NULL,
  terminal_incarnation_id TEXT NOT NULL,
  agent_platform TEXT NOT NULL CHECK(length(agent_platform) BETWEEN 1 AND 64),
  agent_session_id TEXT NOT NULL,
  model_id TEXT,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  UNIQUE(terminal_id,terminal_incarnation_id,agent_session_id),
  FOREIGN KEY(terminal_id,terminal_incarnation_id) REFERENCES terminal_sessions(terminal_id,terminal_incarnation_id)
);

CREATE TABLE terminal_failures (
  failure_id TEXT PRIMARY KEY,
  terminal_id TEXT NOT NULL,
  terminal_incarnation_id TEXT NOT NULL,
  project_id TEXT,
  source_event_id TEXT NOT NULL REFERENCES terminal_events(event_id),
  failure_class TEXT NOT NULL CHECK(length(failure_class) BETWEEN 1 AND 64),
  summary TEXT NOT NULL CHECK(length(summary) BETWEEN 1 AND 1024),
  status TEXT NOT NULL CHECK(status IN ('open','investigating','resolved','accepted-risk','superseded','invalidated')),
  opened_at TEXT NOT NULL,
  resolved_at TEXT,
  resolution_id TEXT,
  severity TEXT NOT NULL CHECK(severity IN ('P0','P1','P2','P3')),
  UNIQUE(source_event_id),
  FOREIGN KEY(terminal_id,terminal_incarnation_id) REFERENCES terminal_sessions(terminal_id,terminal_incarnation_id)
);
CREATE INDEX terminal_failures_status ON terminal_failures(status,severity,opened_at,failure_id);

CREATE TABLE terminal_resolutions (
  resolution_id TEXT PRIMARY KEY,
  failure_id TEXT NOT NULL UNIQUE REFERENCES terminal_failures(failure_id),
  source_event_ids_json TEXT NOT NULL,
  summary TEXT NOT NULL CHECK(length(summary) BETWEEN 1 AND 1024),
  verification_id TEXT NOT NULL,
  verified_at TEXT NOT NULL,
  correlation_id TEXT NOT NULL UNIQUE
);

CREATE TABLE terminal_closeouts (
  closeout_id TEXT PRIMARY KEY,
  work_id TEXT NOT NULL,
  correlation_id TEXT NOT NULL UNIQUE,
  terminal_ids_json TEXT NOT NULL,
  project_ids_json TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK(outcome IN ('success','partial','failed','cancelled','blocked','uncertain')),
  verified_result_json TEXT NOT NULL,
  failed_items_json TEXT NOT NULL,
  unresolved_items_json TEXT NOT NULL,
  artifacts_json TEXT NOT NULL,
  commit_refs_json TEXT NOT NULL,
  issue_refs_json TEXT NOT NULL,
  improvements_json TEXT NOT NULL,
  next_actions_json TEXT NOT NULL,
  canonical_digest TEXT NOT NULL UNIQUE,
  signed_at TEXT NOT NULL
);
CREATE INDEX terminal_closeouts_work ON terminal_closeouts(work_id,signed_at,closeout_id);

CREATE TABLE terminal_checkpoints (
  checkpoint_id TEXT PRIMARY KEY,
  correlation_id TEXT NOT NULL,
  terminal_id TEXT,
  work_id TEXT,
  purpose TEXT NOT NULL CHECK(length(purpose) BETWEEN 1 AND 512),
  decision TEXT NOT NULL CHECK(length(decision) BETWEEN 1 AND 2048),
  failure_summary TEXT,
  verification_summary TEXT,
  next_step TEXT,
  created_at TEXT NOT NULL,
  checkpoint_digest TEXT NOT NULL UNIQUE
);
CREATE INDEX terminal_checkpoints_correlation ON terminal_checkpoints(correlation_id,created_at,checkpoint_id);

CREATE TABLE terminal_improvements (
  improvement_id TEXT PRIMARY KEY,
  closeout_id TEXT NOT NULL REFERENCES terminal_closeouts(closeout_id),
  category TEXT NOT NULL CHECK(category IN ('repeated_failure','manual_command','dirty_worktree','verification_gap','approval_bottleneck','duplicate_worker','stale_terminal','polling','model_cost','recurring_incident')),
  summary TEXT NOT NULL CHECK(length(summary) BETWEEN 1 AND 1024),
  issue_draft_digest TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX terminal_improvements_closeout ON terminal_improvements(closeout_id,created_at,improvement_id);

CREATE TRIGGER terminal_events_immutable_update BEFORE UPDATE ON terminal_events BEGIN SELECT RAISE(ABORT,'immutable terminal event'); END;
CREATE TRIGGER terminal_events_immutable_delete BEFORE DELETE ON terminal_events BEGIN SELECT RAISE(ABORT,'immutable terminal event'); END;
CREATE TRIGGER terminal_resolutions_immutable_update BEFORE UPDATE ON terminal_resolutions BEGIN SELECT RAISE(ABORT,'immutable terminal resolution'); END;
CREATE TRIGGER terminal_resolutions_immutable_delete BEFORE DELETE ON terminal_resolutions BEGIN SELECT RAISE(ABORT,'immutable terminal resolution'); END;
CREATE TRIGGER terminal_closeouts_immutable_update BEFORE UPDATE ON terminal_closeouts BEGIN SELECT RAISE(ABORT,'immutable terminal closeout'); END;
CREATE TRIGGER terminal_closeouts_immutable_delete BEFORE DELETE ON terminal_closeouts BEGIN SELECT RAISE(ABORT,'immutable terminal closeout'); END;
CREATE TRIGGER terminal_checkpoints_immutable_update BEFORE UPDATE ON terminal_checkpoints BEGIN SELECT RAISE(ABORT,'immutable terminal checkpoint'); END;

CREATE TABLE workflow_correlations (
  correlation_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  work_id TEXT NOT NULL,
  recommendation_id TEXT,
  task_id TEXT NOT NULL,
  dispatch_id TEXT,
  terminal_id TEXT,
  terminal_incarnation_id TEXT,
  worktree_id TEXT,
  agent_session_id TEXT,
  progress_id TEXT,
  verification_id TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(task_id),
  UNIQUE(dispatch_id),
  UNIQUE(terminal_id,terminal_incarnation_id)
);
CREATE TABLE workflow_correlation_events (
  event_id TEXT PRIMARY KEY,
  correlation_id TEXT NOT NULL REFERENCES workflow_correlations(correlation_id),
  kind TEXT NOT NULL CHECK(kind IN ('dispatch','terminal','worktree','progress','verification','failure','resolution','closeout')),
  idempotency_key TEXT NOT NULL UNIQUE,
  payload_digest TEXT NOT NULL,
  evidence_digest TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX workflow_correlation_events_lookup ON workflow_correlation_events(correlation_id,created_at,event_id);
CREATE TRIGGER workflow_correlations_immutable_update BEFORE UPDATE ON workflow_correlations BEGIN SELECT RAISE(ABORT,'immutable workflow correlation'); END;
CREATE TRIGGER workflow_correlations_immutable_delete BEFORE DELETE ON workflow_correlations BEGIN SELECT RAISE(ABORT,'immutable workflow correlation'); END;
CREATE TRIGGER workflow_correlation_events_immutable_update BEFORE UPDATE ON workflow_correlation_events BEGIN SELECT RAISE(ABORT,'immutable workflow correlation event'); END;
CREATE TRIGGER workflow_correlation_events_immutable_delete BEFORE DELETE ON workflow_correlation_events BEGIN SELECT RAISE(ABORT,'immutable workflow correlation event'); END;
CREATE TRIGGER terminal_checkpoints_immutable_delete BEFORE DELETE ON terminal_checkpoints BEGIN SELECT RAISE(ABORT,'immutable terminal checkpoint'); END;
