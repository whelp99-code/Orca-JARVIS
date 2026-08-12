CREATE TABLE feature_deprecations (
  feature_id TEXT PRIMARY KEY,
  replacement TEXT NOT NULL,
  reason TEXT NOT NULL,
  deprecated_at TEXT NOT NULL
);
INSERT INTO feature_deprecations(feature_id,replacement,reason,deprecated_at)
VALUES(
  'collaboration-workspace',
  'task-timeline',
  'JARVIS is an AgentOps control plane; Buzz concepts are retained only as a read-only timeline UX over existing authoritative records.',
  '2026-08-12T00:00:00.000Z'
);
CREATE TRIGGER feature_deprecations_immutable_update BEFORE UPDATE ON feature_deprecations BEGIN SELECT RAISE(ABORT,'immutable feature deprecation'); END;
CREATE TRIGGER feature_deprecations_immutable_delete BEFORE DELETE ON feature_deprecations BEGIN SELECT RAISE(ABORT,'immutable feature deprecation'); END;

-- Migration 025 has already shipped to the live database and must remain byte-for-byte
-- immutable.  These fail-closed insert/update guards retire the unused parallel
-- collaboration platform without deleting any historical rows that may exist.
CREATE TRIGGER collaboration_identities_deprecated_insert BEFORE INSERT ON collaboration_identities BEGIN SELECT RAISE(ABORT,'COLLABORATION_DEPRECATED_USE_TASK_TIMELINE'); END;
CREATE TRIGGER collaboration_identity_revocations_deprecated_insert BEFORE INSERT ON collaboration_identity_revocations BEGIN SELECT RAISE(ABORT,'COLLABORATION_DEPRECATED_USE_TASK_TIMELINE'); END;
CREATE TRIGGER collaboration_rooms_deprecated_insert BEFORE INSERT ON collaboration_rooms BEGIN SELECT RAISE(ABORT,'COLLABORATION_DEPRECATED_USE_TASK_TIMELINE'); END;
CREATE TRIGGER collaboration_memberships_deprecated_insert BEFORE INSERT ON collaboration_memberships BEGIN SELECT RAISE(ABORT,'COLLABORATION_DEPRECATED_USE_TASK_TIMELINE'); END;
CREATE TRIGGER collaboration_membership_revocations_deprecated_insert BEFORE INSERT ON collaboration_membership_revocations BEGIN SELECT RAISE(ABORT,'COLLABORATION_DEPRECATED_USE_TASK_TIMELINE'); END;
CREATE TRIGGER collaboration_events_deprecated_insert BEFORE INSERT ON collaboration_events BEGIN SELECT RAISE(ABORT,'COLLABORATION_DEPRECATED_USE_TASK_TIMELINE'); END;
CREATE TRIGGER collaboration_bridge_deprecated_insert BEFORE INSERT ON collaboration_bridge_outbox BEGIN SELECT RAISE(ABORT,'COLLABORATION_DEPRECATED_USE_TASK_TIMELINE'); END;
CREATE TRIGGER collaboration_bridge_deprecated_update BEFORE UPDATE ON collaboration_bridge_outbox BEGIN SELECT RAISE(ABORT,'COLLABORATION_DEPRECATED_USE_TASK_TIMELINE'); END;

CREATE INDEX task_timeline_event_ledger_work ON event_ledger(work_id,seq);
CREATE INDEX task_timeline_audit_subject ON audit_facts(subject_id,seq);
CREATE INDEX task_timeline_control_subject ON control_events(subject,seq);
CREATE INDEX task_timeline_workflow_correlation ON workflow_runs(correlation_id,updated_at,run_id);
CREATE INDEX task_timeline_gjc_continuation ON gjc_intents(continuation_id,created_at,intent_id);
CREATE INDEX task_timeline_progress_worktree ON progress_observations(worktree_selector,created_at,observation_identity);
