-- allow: SIZE_OK - indivisible forward migration for one personal-operations schema boundary.
CREATE TABLE daily_loop_runs (
  run_id TEXT PRIMARY KEY,
  loop_date TEXT NOT NULL CHECK(strftime('%Y-%m-%d',loop_date) IS NOT NULL AND strftime('%Y-%m-%d',loop_date)=loop_date),
  correlation_id TEXT NOT NULL UNIQUE,
  idempotency_key TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL CHECK(state IN ('pending','claimed','running','verifying','completed','failed','uncertain')),
  lease_owner TEXT,
  lease_fence INTEGER NOT NULL DEFAULT 0 CHECK(lease_fence>=0),
  lease_expires_at TEXT CHECK(lease_expires_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ',lease_expires_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',lease_expires_at)=lease_expires_at),
  expires_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',expires_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',expires_at)=expires_at),
  result_digest TEXT,
  failure_code TEXT,
  created_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',created_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',created_at)=created_at),
  updated_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',updated_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',updated_at)=updated_at),
  CHECK(julianday(expires_at)>julianday(created_at)),
  CHECK((lease_owner IS NULL AND lease_expires_at IS NULL) OR (lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL AND lease_fence>0)),
  CHECK(state NOT IN ('claimed','running','verifying') OR lease_owner IS NOT NULL)
);
CREATE INDEX daily_loop_runs_state ON daily_loop_runs(state,loop_date,run_id);
CREATE INDEX daily_loop_runs_lease ON daily_loop_runs(lease_expires_at,run_id) WHERE lease_owner IS NOT NULL;

CREATE TABLE daily_loop_steps (
  step_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES daily_loop_runs(run_id),
  sequence INTEGER NOT NULL CHECK(sequence>0),
  step_key TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('pending','claimed','running','verifying','completed','failed','uncertain')),
  evidence_digest TEXT,
  result_digest TEXT,
  created_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',created_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',created_at)=created_at),
  updated_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',updated_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',updated_at)=updated_at),
  UNIQUE(run_id,sequence), UNIQUE(run_id,step_key)
);
CREATE INDEX daily_loop_steps_state ON daily_loop_steps(run_id,state,sequence);

CREATE TABLE daily_loop_checkpoints (
  checkpoint_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES daily_loop_runs(run_id),
  step_id TEXT REFERENCES daily_loop_steps(step_id),
  sequence INTEGER NOT NULL CHECK(sequence>0),
  state TEXT NOT NULL CHECK(state IN ('pending','claimed','running','verifying','completed','failed','uncertain')),
  previous_digest TEXT,
  checkpoint_digest TEXT NOT NULL UNIQUE,
  lease_fence INTEGER NOT NULL CHECK(lease_fence>0),
  lease_expires_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',lease_expires_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',lease_expires_at)=lease_expires_at),
  created_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',created_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',created_at)=created_at),
  UNIQUE(run_id,sequence)
);
CREATE INDEX daily_loop_checkpoints_run ON daily_loop_checkpoints(run_id,sequence);

CREATE TABLE notification_intents (
  intent_id TEXT PRIMARY KEY,
  correlation_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  dedup_key TEXT NOT NULL UNIQUE,
  urgency TEXT NOT NULL CHECK(urgency IN ('info','action','critical')),
  channel TEXT NOT NULL CHECK(channel IN ('mac','browser','phone')),
  redacted_preview TEXT NOT NULL CHECK(length(redacted_preview) BETWEEN 1 AND 512),
  deep_link TEXT NOT NULL CHECK(length(deep_link) BETWEEN 1 AND 512),
  state TEXT NOT NULL CHECK(state IN ('created','deferred','queued','delivering','delivered','suppressed','failed','expired')),
  expires_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',expires_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',expires_at)=expires_at),
  created_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',created_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',created_at)=created_at),
  updated_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',updated_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',updated_at)=updated_at),
  CHECK(julianday(expires_at)>julianday(created_at))
);
CREATE INDEX notification_intents_state ON notification_intents(state,expires_at,intent_id);

CREATE TABLE notification_deliveries (
  delivery_id TEXT PRIMARY KEY,
  intent_id TEXT NOT NULL REFERENCES notification_intents(intent_id),
  idempotency_key TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL CHECK(state IN ('created','deferred','queued','delivering','delivered','suppressed','failed','expired')),
  lease_owner TEXT,
  lease_fence INTEGER NOT NULL DEFAULT 0 CHECK(lease_fence>=0),
  lease_expires_at TEXT CHECK(lease_expires_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ',lease_expires_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',lease_expires_at)=lease_expires_at),
  attempt_digest TEXT,
  receipt_digest TEXT UNIQUE,
  delivered_at TEXT CHECK(delivered_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ',delivered_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',delivered_at)=delivered_at),
  created_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',created_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',created_at)=created_at),
  updated_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',updated_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',updated_at)=updated_at),
  UNIQUE(intent_id,idempotency_key),
  CHECK((lease_owner IS NULL AND lease_expires_at IS NULL) OR (lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL AND lease_fence>0)),
  CHECK(state<>'delivering' OR lease_owner IS NOT NULL)
);
CREATE INDEX notification_deliveries_state ON notification_deliveries(state,lease_expires_at,delivery_id);

CREATE TABLE memory_candidates (
  candidate_id TEXT PRIMARY KEY,
  correlation_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  candidate_kind TEXT NOT NULL CHECK(candidate_kind IN ('verified_fact','user_instruction','inference','correction','forget')),
  operation TEXT NOT NULL CHECK(operation IN ('remember','correct','forget','export')),
  subject_digest TEXT NOT NULL,
  content_digest TEXT NOT NULL,
  source_digest TEXT NOT NULL,
  sensitivity TEXT NOT NULL CHECK(sensitivity IN ('normal','sensitive','restricted')),
  purpose TEXT NOT NULL,
  required_confirmation INTEGER NOT NULL CHECK(required_confirmation IN (0,1)),
  state TEXT NOT NULL CHECK(state IN ('proposed','classified','awaiting_confirmation','approved','queued','delivering','accepted_unsettled','settled','rejected','uncertain','expired')),
  confirmation_expires_at TEXT CHECK(confirmation_expires_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ',confirmation_expires_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',confirmation_expires_at)=confirmation_expires_at),
  expires_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',expires_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',expires_at)=expires_at),
  created_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',created_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',created_at)=created_at),
  updated_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',updated_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',updated_at)=updated_at),
  CHECK(julianday(expires_at)>julianday(created_at)),
  CHECK(required_confirmation=0 OR confirmation_expires_at IS NOT NULL)
);
CREATE INDEX memory_candidates_state ON memory_candidates(state,expires_at,candidate_id);
CREATE INDEX memory_candidates_subject ON memory_candidates(subject_digest,created_at,candidate_id);

CREATE TABLE memory_outbox (
  outbox_id TEXT PRIMARY KEY,
  candidate_id TEXT NOT NULL UNIQUE REFERENCES memory_candidates(candidate_id),
  idempotency_key TEXT NOT NULL UNIQUE,
  operation TEXT NOT NULL CHECK(operation IN ('remember','correct','forget','export')),
  request_digest TEXT NOT NULL,
  expected_artifact_digest TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('proposed','classified','awaiting_confirmation','approved','queued','delivering','accepted_unsettled','settled','rejected','uncertain','expired')),
  lease_owner TEXT,
  lease_fence INTEGER NOT NULL DEFAULT 0 CHECK(lease_fence>=0),
  lease_expires_at TEXT CHECK(lease_expires_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ',lease_expires_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',lease_expires_at)=lease_expires_at),
  expires_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',expires_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',expires_at)=expires_at),
  settled_at TEXT CHECK(settled_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ',settled_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',settled_at)=settled_at),
  created_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',created_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',created_at)=created_at),
  updated_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',updated_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',updated_at)=updated_at),
  CHECK(julianday(expires_at)>julianday(created_at)),
  CHECK((lease_owner IS NULL AND lease_expires_at IS NULL) OR (lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL AND lease_fence>0)),
  CHECK(state<>'delivering' OR lease_owner IS NOT NULL)
);
CREATE INDEX memory_outbox_state ON memory_outbox(state,lease_expires_at,outbox_id);

CREATE TABLE memory_outbox_attempts (
  attempt_id TEXT PRIMARY KEY,
  outbox_id TEXT NOT NULL REFERENCES memory_outbox(outbox_id),
  lease_fence INTEGER NOT NULL CHECK(lease_fence>0),
  invocation_digest TEXT NOT NULL UNIQUE,
  outcome TEXT NOT NULL CHECK(outcome IN ('accepted','rejected','uncertain')),
  error_code TEXT,
  created_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',created_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',created_at)=created_at),
  UNIQUE(outbox_id,lease_fence)
);
CREATE INDEX memory_outbox_attempts_outbox ON memory_outbox_attempts(outbox_id,created_at,attempt_id);

CREATE TABLE memory_reconciliation_events (
  event_id TEXT PRIMARY KEY,
  outbox_id TEXT NOT NULL REFERENCES memory_outbox(outbox_id),
  attempt_id TEXT REFERENCES memory_outbox_attempts(attempt_id),
  lease_fence INTEGER NOT NULL CHECK(lease_fence>0),
  event_type TEXT NOT NULL CHECK(event_type IN ('accepted','artifact_observed','artifact_missing','conflict','uncertain')),
  observed_artifact_digest TEXT,
  effect_digest TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',created_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',created_at)=created_at)
);
CREATE INDEX memory_reconciliation_outbox ON memory_reconciliation_events(outbox_id,created_at,event_id);

CREATE TABLE memory_deletion_requests (
  deletion_id TEXT PRIMARY KEY,
  correlation_id TEXT NOT NULL UNIQUE,
  idempotency_key TEXT NOT NULL UNIQUE,
  operation TEXT NOT NULL CHECK(operation='forget'),
  subject_digest TEXT NOT NULL,
  scope_digest TEXT NOT NULL,
  target_digest TEXT NOT NULL,
  args_digest TEXT NOT NULL,
  requested_by TEXT NOT NULL CHECK(requested_by='local-owner'),
  state TEXT NOT NULL CHECK(state IN ('requested','approved','queued','applying','tombstoned','settled','rejected','expired','failed','uncertain')),
  confirmation_request_id TEXT REFERENCES control_command_requests(request_id),
  confirmation_receipt_id TEXT UNIQUE REFERENCES control_command_receipts(receipt_id),
  confirmation_receipt_digest TEXT,
  lease_owner TEXT,
  lease_fence INTEGER NOT NULL DEFAULT 0 CHECK(lease_fence>=0),
  lease_expires_at TEXT CHECK(lease_expires_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ',lease_expires_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',lease_expires_at)=lease_expires_at),
  expires_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',expires_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',expires_at)=expires_at),
  created_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',created_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',created_at)=created_at),
  updated_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',updated_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',updated_at)=updated_at),
  CHECK(julianday(expires_at)>julianday(created_at)),
  CHECK((confirmation_request_id IS NULL AND confirmation_receipt_id IS NULL AND confirmation_receipt_digest IS NULL) OR (confirmation_request_id IS NOT NULL AND confirmation_receipt_id IS NOT NULL AND confirmation_receipt_digest IS NOT NULL)),
  CHECK((lease_owner IS NULL AND lease_expires_at IS NULL) OR (lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL AND lease_fence>0)),
  CHECK(state<>'applying' OR lease_owner IS NOT NULL)
);
CREATE INDEX memory_deletion_state ON memory_deletion_requests(state,expires_at,deletion_id);
CREATE INDEX memory_deletion_subject ON memory_deletion_requests(subject_digest,created_at,deletion_id);

CREATE TABLE memory_tombstones (
  tombstone_id TEXT PRIMARY KEY,
  deletion_id TEXT NOT NULL UNIQUE REFERENCES memory_deletion_requests(deletion_id),
  subject_digest TEXT NOT NULL UNIQUE,
  scope_digest TEXT NOT NULL,
  target_digest TEXT NOT NULL,
  args_digest TEXT NOT NULL,
  approval_request_id TEXT NOT NULL REFERENCES control_command_requests(request_id),
  approval_receipt_id TEXT NOT NULL REFERENCES control_command_receipts(receipt_id),
  approval_receipt_digest TEXT NOT NULL,
  effective_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',effective_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',effective_at)=effective_at),
  tombstone_digest TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',created_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',created_at)=created_at)
);
CREATE INDEX memory_tombstones_effective ON memory_tombstones(effective_at,tombstone_id);

CREATE TABLE personal_authority_redemptions (
  receipt_id TEXT PRIMARY KEY REFERENCES control_command_receipts(receipt_id),
  request_id TEXT NOT NULL UNIQUE REFERENCES control_command_requests(request_id),
  authority_kind TEXT NOT NULL CHECK(authority_kind IN ('memory_deletion','remote_enrollment')),
  subject_id TEXT NOT NULL,
  binding_digest TEXT NOT NULL,
  consumed_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',consumed_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',consumed_at)=consumed_at)
);

CREATE TABLE remote_principals (
  principal_id TEXT PRIMARY KEY,
  state TEXT NOT NULL CHECK(state IN ('absent','active','revoked')),
  subject_digest TEXT NOT NULL,
  credential_public_key_digest TEXT,
  target_digest TEXT,
  args_digest TEXT,
  local_owner_session_id TEXT,
  enrollment_request_id TEXT REFERENCES control_command_requests(request_id),
  enrollment_receipt_id TEXT UNIQUE REFERENCES control_command_receipts(receipt_id),
  enrollment_receipt_digest TEXT,
  enrollment_expires_at TEXT CHECK(enrollment_expires_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ',enrollment_expires_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',enrollment_expires_at)=enrollment_expires_at),
  activated_at TEXT CHECK(activated_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ',activated_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',activated_at)=activated_at),
  revoked_at TEXT CHECK(revoked_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ',revoked_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',revoked_at)=revoked_at),
  created_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',created_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',created_at)=created_at),
  CHECK((state='absent' AND credential_public_key_digest IS NULL AND target_digest IS NULL AND args_digest IS NULL AND local_owner_session_id IS NULL AND enrollment_request_id IS NULL AND enrollment_receipt_id IS NULL AND enrollment_receipt_digest IS NULL AND enrollment_expires_at IS NULL AND activated_at IS NULL AND revoked_at IS NULL) OR (state='active' AND enrollment_request_id IS NOT NULL AND enrollment_receipt_id IS NOT NULL AND enrollment_receipt_digest IS NOT NULL AND credential_public_key_digest IS NOT NULL AND target_digest IS NOT NULL AND args_digest IS NOT NULL AND local_owner_session_id IS NOT NULL AND enrollment_expires_at IS NOT NULL AND activated_at IS NOT NULL AND revoked_at IS NULL) OR (state='revoked' AND revoked_at IS NOT NULL))
);
CREATE INDEX remote_principals_state ON remote_principals(state,principal_id);

CREATE TABLE webauthn_credentials (
  credential_id TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL REFERENCES remote_principals(principal_id),
  public_key_cose TEXT NOT NULL,
  public_key_digest TEXT NOT NULL UNIQUE,
  sign_count INTEGER NOT NULL DEFAULT 0 CHECK(sign_count>=0),
  state TEXT NOT NULL CHECK(state IN ('active','revoked')),
  rp_id TEXT NOT NULL,
  origin TEXT NOT NULL,
  created_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',created_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',created_at)=created_at),
  revoked_at TEXT CHECK(revoked_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ',revoked_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',revoked_at)=revoked_at),
  CHECK((state='active' AND revoked_at IS NULL) OR (state='revoked' AND revoked_at IS NOT NULL))
);
CREATE INDEX webauthn_credentials_principal ON webauthn_credentials(principal_id,state,credential_id);

CREATE TABLE webauthn_challenges (
  challenge_id TEXT PRIMARY KEY,
  command_request_id TEXT NOT NULL REFERENCES control_command_requests(request_id),
  principal_id TEXT NOT NULL REFERENCES remote_principals(principal_id),
  credential_id TEXT NOT NULL REFERENCES webauthn_credentials(credential_id),
  session_id TEXT NOT NULL,
  command_digest TEXT NOT NULL,
  target_digest TEXT NOT NULL,
  args_digest TEXT NOT NULL,
  challenge_digest TEXT NOT NULL UNIQUE,
  nonce_digest TEXT NOT NULL UNIQUE,
  rp_id TEXT NOT NULL,
  origin TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('issued','consumed','expired','rejected')),
  issued_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',issued_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',issued_at)=issued_at),
  expires_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',expires_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',expires_at)=expires_at),
  consumed_at TEXT CHECK(consumed_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ',consumed_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',consumed_at)=consumed_at),
  CHECK(julianday(expires_at)>julianday(issued_at)),
  CHECK(julianday(expires_at)-julianday(issued_at)<=15.0/1440.0),
  CHECK((state='issued' AND consumed_at IS NULL) OR (state='consumed' AND consumed_at IS NOT NULL) OR state IN ('expired','rejected'))
);
CREATE INDEX webauthn_challenges_principal ON webauthn_challenges(principal_id,state,expires_at,challenge_id);
CREATE INDEX webauthn_challenges_session ON webauthn_challenges(session_id,state,expires_at,challenge_id);

CREATE TABLE webauthn_assertions (
  assertion_id TEXT PRIMARY KEY,
  challenge_id TEXT NOT NULL UNIQUE REFERENCES webauthn_challenges(challenge_id),
  principal_id TEXT NOT NULL REFERENCES remote_principals(principal_id),
  credential_id TEXT NOT NULL REFERENCES webauthn_credentials(credential_id),
  session_id TEXT NOT NULL,
  command_digest TEXT NOT NULL,
  target_digest TEXT NOT NULL,
  args_digest TEXT NOT NULL,
  nonce_digest TEXT NOT NULL,
  rp_id TEXT NOT NULL,
  origin TEXT NOT NULL,
  assertion_digest TEXT NOT NULL UNIQUE,
  sign_count INTEGER NOT NULL CHECK(sign_count>0),
  user_verified INTEGER NOT NULL CHECK(user_verified=1),
  asserted_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',asserted_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',asserted_at)=asserted_at)
);
CREATE INDEX webauthn_assertions_principal ON webauthn_assertions(principal_id,asserted_at,assertion_id);

CREATE TABLE retention_jobs (
  job_id TEXT PRIMARY KEY,
  job_key TEXT NOT NULL UNIQUE,
  idempotency_key TEXT NOT NULL UNIQUE,
  data_class TEXT NOT NULL CHECK(data_class IN ('observation','context','recommendation','notification','memory_candidate','audit','delete')),
  state TEXT NOT NULL CHECK(state IN ('pending','claimed','completed','failed','uncertain')),
  lease_owner TEXT,
  lease_fence INTEGER NOT NULL DEFAULT 0 CHECK(lease_fence>=0),
  lease_expires_at TEXT CHECK(lease_expires_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ',lease_expires_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',lease_expires_at)=lease_expires_at),
  not_before TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',not_before) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',not_before)=not_before),
  expires_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',expires_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',expires_at)=expires_at),
  result_digest TEXT,
  failure_code TEXT,
  created_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',created_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',created_at)=created_at),
  updated_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',updated_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',updated_at)=updated_at),
  CHECK(julianday(expires_at)>julianday(not_before)),
  CHECK((lease_owner IS NULL AND lease_expires_at IS NULL) OR (lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL AND lease_fence>0)),
  CHECK(state<>'claimed' OR lease_owner IS NOT NULL)
);
CREATE INDEX retention_jobs_state ON retention_jobs(state,not_before,expires_at,job_id);
CREATE INDEX retention_jobs_lease ON retention_jobs(lease_expires_at,job_id) WHERE lease_owner IS NOT NULL;

CREATE TABLE personal_operation_audit_events (
  event_id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  subject_kind TEXT NOT NULL CHECK(subject_kind IN ('daily_loop','notification','memory_candidate','memory_outbox','deletion','tombstone','principal','credential','challenge','assertion','retention')),
  subject_id TEXT NOT NULL,
  principal_id TEXT,
  correlation_id TEXT NOT NULL,
  causation_id TEXT,
  event_digest TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',created_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',created_at)=created_at)
);
CREATE INDEX personal_operation_audit_subject ON personal_operation_audit_events(subject_kind,subject_id,created_at,event_id);
CREATE INDEX personal_operation_audit_correlation ON personal_operation_audit_events(correlation_id,created_at,event_id);

CREATE TRIGGER daily_loop_runs_initial_state BEFORE INSERT ON daily_loop_runs WHEN NEW.state<>'pending' BEGIN SELECT RAISE(ABORT,'daily loop must start pending'); END;
CREATE TRIGGER daily_loop_runs_identity_immutable BEFORE UPDATE OF run_id,loop_date,correlation_id,idempotency_key,expires_at,created_at ON daily_loop_runs BEGIN SELECT RAISE(ABORT,'immutable daily loop identity'); END;
CREATE TRIGGER daily_loop_runs_transition BEFORE UPDATE OF state ON daily_loop_runs WHEN OLD.state<>NEW.state AND OLD.state||':'||NEW.state NOT IN ('pending:claimed','pending:failed','claimed:running','claimed:failed','claimed:uncertain','running:verifying','running:failed','running:uncertain','verifying:completed','verifying:failed','verifying:uncertain') BEGIN SELECT RAISE(ABORT,'daily loop transition invalid'); END;
CREATE TRIGGER daily_loop_runs_claim_guard BEFORE UPDATE OF lease_fence ON daily_loop_runs WHEN OLD.lease_fence=0 AND NOT (NEW.lease_fence=1 AND OLD.state='pending' AND NEW.state='claimed' AND NEW.lease_owner IS NOT NULL AND julianday(NEW.lease_expires_at)>julianday(NEW.updated_at) AND julianday(NEW.lease_expires_at)<=julianday(NEW.expires_at)) BEGIN SELECT RAISE(ABORT,'daily loop claim invalid'); END;
CREATE TRIGGER daily_loop_runs_reclaim_guard BEFORE UPDATE OF lease_fence ON daily_loop_runs WHEN OLD.lease_fence>0 AND NEW.lease_fence<>OLD.lease_fence AND julianday(OLD.lease_expires_at)<=julianday(NEW.updated_at) AND NOT (NEW.lease_fence=OLD.lease_fence+1 AND OLD.lease_owner IS NOT NULL AND NEW.lease_owner IS NOT NULL AND NEW.lease_owner<>OLD.lease_owner AND julianday(OLD.lease_expires_at)<=julianday(NEW.updated_at) AND julianday(NEW.lease_expires_at)>julianday(NEW.updated_at) AND julianday(NEW.lease_expires_at)<=julianday(NEW.expires_at) AND NEW.state=OLD.state) BEGIN SELECT RAISE(ABORT,'daily loop reclaim invalid'); END;
CREATE TRIGGER daily_loop_runs_active_lease BEFORE UPDATE OF lease_owner,lease_fence ON daily_loop_runs WHEN OLD.lease_owner IS NOT NULL AND ((NEW.lease_owner IS NOT NULL AND NEW.lease_owner IS NOT OLD.lease_owner) OR NEW.lease_fence<>OLD.lease_fence) AND julianday(OLD.lease_expires_at)>julianday(NEW.updated_at) BEGIN SELECT RAISE(ABORT,'daily loop active lease exists'); END;
CREATE TRIGGER daily_loop_runs_lease_expiry_guard BEFORE UPDATE OF lease_expires_at ON daily_loop_runs WHEN NEW.lease_owner IS NOT NULL AND (julianday(NEW.lease_expires_at)<=julianday(NEW.updated_at) OR julianday(NEW.lease_expires_at)>julianday(NEW.expires_at) OR julianday(NEW.lease_expires_at)>julianday(NEW.updated_at)+15.0/1440.0) BEGIN SELECT RAISE(ABORT,'daily loop lease expiry invalid'); END;
CREATE TRIGGER daily_loop_steps_initial_state BEFORE INSERT ON daily_loop_steps WHEN NEW.state<>'pending' BEGIN SELECT RAISE(ABORT,'daily loop step must start pending'); END;
CREATE TRIGGER daily_loop_steps_transition BEFORE UPDATE OF state ON daily_loop_steps WHEN OLD.state<>NEW.state AND OLD.state||':'||NEW.state NOT IN ('pending:claimed','pending:failed','claimed:running','claimed:failed','claimed:uncertain','running:verifying','running:failed','running:uncertain','verifying:completed','verifying:failed','verifying:uncertain') BEGIN SELECT RAISE(ABORT,'daily loop step transition invalid'); END;
CREATE TRIGGER daily_loop_checkpoints_immutable_update BEFORE UPDATE ON daily_loop_checkpoints BEGIN SELECT RAISE(ABORT,'immutable daily loop checkpoint'); END;
CREATE TRIGGER daily_loop_checkpoints_immutable_delete BEFORE DELETE ON daily_loop_checkpoints BEGIN SELECT RAISE(ABORT,'immutable daily loop checkpoint'); END;

CREATE TRIGGER notification_intents_initial_state BEFORE INSERT ON notification_intents WHEN NEW.state<>'created' BEGIN SELECT RAISE(ABORT,'notification must start created'); END;
CREATE TRIGGER notification_intents_identity_immutable BEFORE UPDATE OF intent_id,correlation_id,idempotency_key,dedup_key,urgency,channel,redacted_preview,deep_link,expires_at,created_at ON notification_intents BEGIN SELECT RAISE(ABORT,'immutable notification intent identity'); END;
CREATE TRIGGER notification_intents_transition BEFORE UPDATE OF state ON notification_intents WHEN OLD.state<>NEW.state AND OLD.state||':'||NEW.state NOT IN ('created:deferred','created:queued','created:suppressed','created:expired','deferred:queued','deferred:suppressed','deferred:expired','queued:delivering','queued:suppressed','queued:expired','delivering:delivered','delivering:failed','delivering:expired') BEGIN SELECT RAISE(ABORT,'notification transition invalid'); END;
CREATE TRIGGER notification_deliveries_initial_state BEFORE INSERT ON notification_deliveries WHEN NEW.state<>'created' BEGIN SELECT RAISE(ABORT,'notification delivery must start created'); END;
CREATE TRIGGER notification_deliveries_transition BEFORE UPDATE OF state ON notification_deliveries WHEN OLD.state<>NEW.state AND OLD.state||':'||NEW.state NOT IN ('created:deferred','created:queued','created:suppressed','created:expired','deferred:queued','deferred:suppressed','deferred:expired','queued:delivering','queued:suppressed','queued:expired','delivering:delivered','delivering:failed','delivering:expired') BEGIN SELECT RAISE(ABORT,'notification delivery transition invalid'); END;
CREATE TRIGGER notification_deliveries_identity_immutable BEFORE UPDATE OF delivery_id,intent_id,idempotency_key,attempt_digest,created_at ON notification_deliveries BEGIN SELECT RAISE(ABORT,'immutable notification delivery identity'); END;
CREATE TRIGGER notification_deliveries_claim_guard BEFORE UPDATE OF lease_fence ON notification_deliveries WHEN OLD.lease_fence=0 AND NOT (NEW.lease_fence=1 AND OLD.state='queued' AND NEW.state='delivering' AND NEW.lease_owner IS NOT NULL AND julianday(NEW.lease_expires_at)>julianday(NEW.updated_at) AND julianday(NEW.lease_expires_at)<=julianday((SELECT expires_at FROM notification_intents WHERE intent_id=OLD.intent_id))) BEGIN SELECT RAISE(ABORT,'notification claim invalid'); END;
CREATE TRIGGER notification_deliveries_reclaim_guard BEFORE UPDATE OF lease_fence ON notification_deliveries WHEN OLD.lease_fence>0 AND NEW.lease_fence<>OLD.lease_fence AND julianday(OLD.lease_expires_at)<=julianday(NEW.updated_at) AND NOT (NEW.lease_fence=OLD.lease_fence+1 AND NEW.lease_owner IS NOT NULL AND NEW.lease_owner<>OLD.lease_owner AND julianday(OLD.lease_expires_at)<=julianday(NEW.updated_at) AND julianday(NEW.lease_expires_at)>julianday(NEW.updated_at) AND julianday(NEW.lease_expires_at)<=julianday((SELECT expires_at FROM notification_intents WHERE intent_id=OLD.intent_id)) AND NEW.state=OLD.state) BEGIN SELECT RAISE(ABORT,'notification reclaim invalid'); END;
CREATE TRIGGER notification_deliveries_active_lease BEFORE UPDATE OF lease_owner,lease_fence ON notification_deliveries WHEN OLD.lease_owner IS NOT NULL AND ((NEW.lease_owner IS NOT NULL AND NEW.lease_owner IS NOT OLD.lease_owner) OR NEW.lease_fence<>OLD.lease_fence) AND julianday(OLD.lease_expires_at)>julianday(NEW.updated_at) BEGIN SELECT RAISE(ABORT,'notification active lease exists'); END;
CREATE TRIGGER notification_deliveries_lease_expiry_guard BEFORE UPDATE OF lease_expires_at ON notification_deliveries WHEN NEW.lease_owner IS NOT NULL AND (julianday(NEW.lease_expires_at)<=julianday(NEW.updated_at) OR julianday(NEW.lease_expires_at)>julianday((SELECT expires_at FROM notification_intents WHERE intent_id=OLD.intent_id)) OR julianday(NEW.lease_expires_at)>julianday(NEW.updated_at)+15.0/1440.0) BEGIN SELECT RAISE(ABORT,'notification lease expiry invalid'); END;

CREATE TRIGGER memory_candidates_initial_state BEFORE INSERT ON memory_candidates WHEN NEW.state<>'proposed' BEGIN SELECT RAISE(ABORT,'memory candidate must start proposed'); END;
CREATE TRIGGER memory_candidates_identity_immutable BEFORE UPDATE OF candidate_id,correlation_id,idempotency_key,candidate_kind,operation,subject_digest,content_digest,source_digest,sensitivity,purpose,required_confirmation,confirmation_expires_at,expires_at,created_at ON memory_candidates BEGIN SELECT RAISE(ABORT,'immutable memory candidate identity'); END;
CREATE TRIGGER memory_candidates_transition BEFORE UPDATE OF state ON memory_candidates WHEN OLD.state<>NEW.state AND OLD.state||':'||NEW.state NOT IN ('proposed:classified','proposed:rejected','proposed:expired','classified:awaiting_confirmation','classified:approved','classified:rejected','classified:expired','awaiting_confirmation:approved','awaiting_confirmation:rejected','awaiting_confirmation:expired','approved:queued','approved:rejected','approved:expired','queued:delivering','queued:uncertain','queued:expired','delivering:accepted_unsettled','delivering:uncertain','delivering:expired','accepted_unsettled:settled','accepted_unsettled:uncertain','accepted_unsettled:expired') BEGIN SELECT RAISE(ABORT,'memory candidate transition invalid'); END;
CREATE TRIGGER memory_outbox_candidate_guard BEFORE INSERT ON memory_outbox WHEN NEW.state<>'queued' OR NOT EXISTS (SELECT 1 FROM memory_candidates WHERE candidate_id=NEW.candidate_id AND state IN ('approved','queued') AND operation=NEW.operation AND julianday(expires_at)>julianday(NEW.created_at)) BEGIN SELECT RAISE(ABORT,'memory candidate approval required'); END;
CREATE TRIGGER memory_outbox_queue_candidate AFTER INSERT ON memory_outbox BEGIN UPDATE memory_candidates SET state='queued',updated_at=NEW.created_at WHERE candidate_id=NEW.candidate_id; END;
CREATE TRIGGER memory_outbox_identity_immutable BEFORE UPDATE OF outbox_id,candidate_id,idempotency_key,operation,request_digest,expected_artifact_digest,expires_at,created_at ON memory_outbox BEGIN SELECT RAISE(ABORT,'immutable memory outbox identity'); END;
CREATE TRIGGER memory_outbox_transition BEFORE UPDATE OF state ON memory_outbox WHEN OLD.state<>NEW.state AND OLD.state||':'||NEW.state NOT IN ('queued:delivering','queued:uncertain','queued:expired','delivering:accepted_unsettled','delivering:uncertain','delivering:expired','accepted_unsettled:settled','accepted_unsettled:uncertain','accepted_unsettled:expired') BEGIN SELECT RAISE(ABORT,'memory outbox transition invalid'); END;
CREATE TRIGGER memory_outbox_claim_guard BEFORE UPDATE OF lease_fence ON memory_outbox WHEN OLD.lease_fence=0 AND NOT (NEW.lease_fence=1 AND OLD.state='queued' AND NEW.state='delivering' AND NEW.lease_owner IS NOT NULL AND julianday(NEW.lease_expires_at)>julianday(NEW.updated_at) AND julianday(NEW.lease_expires_at)<=julianday(NEW.expires_at)) BEGIN SELECT RAISE(ABORT,'memory outbox claim invalid'); END;
CREATE TRIGGER memory_outbox_reclaim_guard BEFORE UPDATE OF lease_fence ON memory_outbox WHEN OLD.lease_fence>0 AND NEW.lease_fence<>OLD.lease_fence AND julianday(OLD.lease_expires_at)<=julianday(NEW.updated_at) AND NOT (NEW.lease_fence=OLD.lease_fence+1 AND NEW.lease_owner IS NOT NULL AND NEW.lease_owner<>OLD.lease_owner AND julianday(OLD.lease_expires_at)<=julianday(NEW.updated_at) AND julianday(NEW.lease_expires_at)>julianday(NEW.updated_at) AND julianday(NEW.lease_expires_at)<=julianday(NEW.expires_at) AND NEW.state=OLD.state) BEGIN SELECT RAISE(ABORT,'memory outbox reclaim invalid'); END;
CREATE TRIGGER memory_outbox_active_lease BEFORE UPDATE OF lease_owner,lease_fence ON memory_outbox WHEN OLD.lease_owner IS NOT NULL AND ((NEW.lease_owner IS NOT NULL AND NEW.lease_owner IS NOT OLD.lease_owner) OR NEW.lease_fence<>OLD.lease_fence) AND julianday(OLD.lease_expires_at)>julianday(NEW.updated_at) BEGIN SELECT RAISE(ABORT,'memory outbox active lease exists'); END;
CREATE TRIGGER memory_outbox_lease_expiry_guard BEFORE UPDATE OF lease_expires_at ON memory_outbox WHEN NEW.lease_owner IS NOT NULL AND (julianday(NEW.lease_expires_at)<=julianday(NEW.updated_at) OR julianday(NEW.lease_expires_at)>julianday(NEW.expires_at) OR julianday(NEW.lease_expires_at)>julianday(NEW.updated_at)+15.0/1440.0) BEGIN SELECT RAISE(ABORT,'memory outbox lease expiry invalid'); END;
CREATE TRIGGER memory_outbox_settlement_guard BEFORE UPDATE OF state ON memory_outbox WHEN OLD.state='accepted_unsettled' AND NEW.state='settled' AND NOT EXISTS (SELECT 1 FROM memory_reconciliation_events WHERE outbox_id=OLD.outbox_id AND lease_fence=OLD.lease_fence AND event_type='artifact_observed' AND observed_artifact_digest=OLD.expected_artifact_digest) BEGIN SELECT RAISE(ABORT,'memory outbox reconciliation required'); END;
CREATE TRIGGER memory_outbox_attempt_guard BEFORE INSERT ON memory_outbox_attempts WHEN NOT EXISTS (SELECT 1 FROM memory_outbox WHERE outbox_id=NEW.outbox_id AND state='delivering' AND lease_fence=NEW.lease_fence AND julianday(lease_expires_at)>julianday(NEW.created_at)) BEGIN SELECT RAISE(ABORT,'memory outbox current fence required'); END;
CREATE TRIGGER memory_reconciliation_fence_guard BEFORE INSERT ON memory_reconciliation_events WHEN NOT EXISTS (SELECT 1 FROM memory_outbox WHERE outbox_id=NEW.outbox_id AND state='accepted_unsettled' AND lease_fence=NEW.lease_fence AND julianday(lease_expires_at)>julianday(NEW.created_at)) BEGIN SELECT RAISE(ABORT,'memory outbox current fence required'); END;
CREATE TRIGGER memory_outbox_sync_candidate AFTER UPDATE OF state ON memory_outbox BEGIN UPDATE memory_candidates SET state=NEW.state,updated_at=NEW.updated_at WHERE candidate_id=NEW.candidate_id; END;
CREATE TRIGGER memory_outbox_attempts_immutable_update BEFORE UPDATE ON memory_outbox_attempts BEGIN SELECT RAISE(ABORT,'immutable memory outbox attempt'); END;
CREATE TRIGGER memory_outbox_attempts_immutable_delete BEFORE DELETE ON memory_outbox_attempts BEGIN SELECT RAISE(ABORT,'immutable memory outbox attempt'); END;
CREATE TRIGGER memory_reconciliation_immutable_update BEFORE UPDATE ON memory_reconciliation_events BEGIN SELECT RAISE(ABORT,'immutable memory reconciliation event'); END;
CREATE TRIGGER memory_reconciliation_immutable_delete BEFORE DELETE ON memory_reconciliation_events BEGIN SELECT RAISE(ABORT,'immutable memory reconciliation event'); END;

CREATE TRIGGER memory_deletion_initial_state BEFORE INSERT ON memory_deletion_requests WHEN NEW.state<>'requested' OR NEW.confirmation_request_id IS NOT NULL OR NEW.confirmation_receipt_id IS NOT NULL BEGIN SELECT RAISE(ABORT,'memory deletion must start requested'); END;
CREATE TRIGGER memory_deletion_identity_immutable BEFORE UPDATE OF deletion_id,correlation_id,idempotency_key,operation,subject_digest,scope_digest,target_digest,args_digest,requested_by,expires_at,created_at ON memory_deletion_requests BEGIN SELECT RAISE(ABORT,'immutable memory deletion identity'); END;
CREATE TRIGGER memory_deletion_authority_immutable BEFORE UPDATE OF confirmation_request_id,confirmation_receipt_id,confirmation_receipt_digest ON memory_deletion_requests WHEN OLD.confirmation_request_id IS NOT NULL BEGIN SELECT RAISE(ABORT,'immutable memory deletion authority'); END;
CREATE TRIGGER memory_deletion_transition BEFORE UPDATE OF state ON memory_deletion_requests WHEN OLD.state<>NEW.state AND OLD.state||':'||NEW.state NOT IN ('requested:approved','requested:rejected','requested:expired','requested:failed','approved:queued','approved:rejected','approved:expired','approved:failed','queued:applying','queued:failed','queued:uncertain','queued:expired','applying:tombstoned','applying:failed','applying:uncertain','tombstoned:settled','tombstoned:failed','tombstoned:uncertain') BEGIN SELECT RAISE(ABORT,'memory deletion transition invalid'); END;
CREATE TRIGGER memory_deletion_approval_guard BEFORE UPDATE OF state ON memory_deletion_requests WHEN NEW.state='approved' AND NOT EXISTS (SELECT 1 FROM control_command_requests r JOIN control_command_receipts a ON a.request_id=r.request_id WHERE r.request_id=NEW.confirmation_request_id AND a.receipt_id=NEW.confirmation_receipt_id AND r.action='memory.delete' AND r.state='approved' AND a.decision='approve' AND a.command_digest=r.command_digest AND r.requested_by='local-owner' AND a.signer_principal_id=r.requested_by AND a.authenticated_session_id='session:local-owner' AND json_extract(r.target_json,'$.deletion_id')=NEW.deletion_id AND json_extract(r.target_json,'$.subject_digest')=NEW.subject_digest AND json_extract(r.target_json,'$.scope_digest')=NEW.scope_digest AND json_extract(r.target_json,'$.target_digest')=NEW.target_digest AND json_extract(r.args_json,'$.operation')=NEW.operation AND json_extract(r.args_json,'$.args_digest')=NEW.args_digest AND json_extract(a.payload_json,'$.receipt_digest')=NEW.confirmation_receipt_digest AND NOT EXISTS (SELECT 1 FROM personal_authority_redemptions WHERE receipt_id=a.receipt_id OR request_id=r.request_id) AND julianday(NEW.updated_at)<julianday(r.expires_at) AND julianday(NEW.updated_at)<julianday(a.expires_at) AND julianday(NEW.expires_at)<=julianday(r.expires_at) AND julianday(NEW.expires_at)<=julianday(a.expires_at)) BEGIN SELECT RAISE(ABORT,'memory deletion approval required'); END;
CREATE TRIGGER memory_deletion_redeem AFTER UPDATE OF state ON memory_deletion_requests WHEN NEW.state='approved' BEGIN INSERT INTO personal_authority_redemptions(receipt_id,request_id,authority_kind,subject_id,binding_digest,consumed_at) VALUES(NEW.confirmation_receipt_id,NEW.confirmation_request_id,'memory_deletion',NEW.deletion_id,NEW.confirmation_receipt_digest,NEW.updated_at); END;
CREATE TRIGGER memory_deletion_claim_guard BEFORE UPDATE OF lease_fence ON memory_deletion_requests WHEN OLD.lease_fence=0 AND NOT (NEW.lease_fence=1 AND OLD.state='queued' AND NEW.state='applying' AND NEW.lease_owner IS NOT NULL AND julianday(NEW.lease_expires_at)>julianday(NEW.updated_at) AND julianday(NEW.lease_expires_at)<=julianday(NEW.expires_at)) BEGIN SELECT RAISE(ABORT,'memory deletion claim invalid'); END;
CREATE TRIGGER memory_deletion_reclaim_guard BEFORE UPDATE OF lease_fence ON memory_deletion_requests WHEN OLD.lease_fence>0 AND NEW.lease_fence<>OLD.lease_fence AND julianday(OLD.lease_expires_at)<=julianday(NEW.updated_at) AND NOT (NEW.lease_fence=OLD.lease_fence+1 AND NEW.lease_owner IS NOT NULL AND NEW.lease_owner<>OLD.lease_owner AND julianday(OLD.lease_expires_at)<=julianday(NEW.updated_at) AND julianday(NEW.lease_expires_at)>julianday(NEW.updated_at) AND julianday(NEW.lease_expires_at)<=julianday(NEW.expires_at) AND NEW.state=OLD.state) BEGIN SELECT RAISE(ABORT,'memory deletion reclaim invalid'); END;
CREATE TRIGGER memory_deletion_active_lease BEFORE UPDATE OF lease_owner,lease_fence ON memory_deletion_requests WHEN OLD.lease_owner IS NOT NULL AND ((NEW.lease_owner IS NOT NULL AND NEW.lease_owner IS NOT OLD.lease_owner) OR NEW.lease_fence<>OLD.lease_fence) AND julianday(OLD.lease_expires_at)>julianday(NEW.updated_at) BEGIN SELECT RAISE(ABORT,'memory deletion active lease exists'); END;
CREATE TRIGGER memory_deletion_lease_expiry_guard BEFORE UPDATE OF lease_expires_at ON memory_deletion_requests WHEN NEW.lease_owner IS NOT NULL AND (julianday(NEW.lease_expires_at)<=julianday(NEW.updated_at) OR julianday(NEW.lease_expires_at)>julianday(NEW.expires_at) OR julianday(NEW.lease_expires_at)>julianday(NEW.updated_at)+15.0/1440.0) BEGIN SELECT RAISE(ABORT,'memory deletion lease expiry invalid'); END;
CREATE TRIGGER memory_deletion_tombstone_guard BEFORE UPDATE OF state ON memory_deletion_requests WHEN ((OLD.state='applying' AND NEW.state='tombstoned') OR (OLD.state='tombstoned' AND NEW.state='settled')) AND NOT EXISTS (SELECT 1 FROM memory_tombstones WHERE deletion_id=OLD.deletion_id AND subject_digest=OLD.subject_digest AND scope_digest=OLD.scope_digest AND target_digest=OLD.target_digest AND args_digest=OLD.args_digest AND approval_request_id=OLD.confirmation_request_id AND approval_receipt_id=OLD.confirmation_receipt_id AND approval_receipt_digest=OLD.confirmation_receipt_digest) BEGIN SELECT RAISE(ABORT,'memory tombstone required'); END;
CREATE TRIGGER memory_tombstone_insert_guard BEFORE INSERT ON memory_tombstones WHEN NOT EXISTS (SELECT 1 FROM memory_deletion_requests d JOIN personal_authority_redemptions x ON x.receipt_id=d.confirmation_receipt_id AND x.request_id=d.confirmation_request_id WHERE d.deletion_id=NEW.deletion_id AND d.state='applying' AND d.subject_digest=NEW.subject_digest AND d.scope_digest=NEW.scope_digest AND d.target_digest=NEW.target_digest AND d.args_digest=NEW.args_digest AND d.confirmation_request_id=NEW.approval_request_id AND d.confirmation_receipt_id=NEW.approval_receipt_id AND d.confirmation_receipt_digest=NEW.approval_receipt_digest AND julianday(d.lease_expires_at)>julianday(NEW.created_at)) BEGIN SELECT RAISE(ABORT,'memory tombstone authority required'); END;
CREATE TRIGGER memory_tombstones_immutable_update BEFORE UPDATE ON memory_tombstones BEGIN SELECT RAISE(ABORT,'immutable memory tombstone'); END;
CREATE TRIGGER memory_tombstones_immutable_delete BEFORE DELETE ON memory_tombstones BEGIN SELECT RAISE(ABORT,'immutable memory tombstone'); END;
CREATE TRIGGER personal_authority_redemptions_immutable_update BEFORE UPDATE ON personal_authority_redemptions BEGIN SELECT RAISE(ABORT,'immutable personal authority redemption'); END;
CREATE TRIGGER personal_authority_redemptions_immutable_delete BEFORE DELETE ON personal_authority_redemptions BEGIN SELECT RAISE(ABORT,'immutable personal authority redemption'); END;

CREATE TRIGGER remote_principals_initial_state BEFORE INSERT ON remote_principals WHEN NEW.state<>'absent' BEGIN SELECT RAISE(ABORT,'remote principal must start absent'); END;
CREATE TRIGGER remote_principal_enrollment_guard BEFORE UPDATE OF state ON remote_principals WHEN OLD.state='absent' AND NEW.state='active' AND NOT EXISTS (SELECT 1 FROM control_command_requests r JOIN control_command_receipts a ON a.request_id=r.request_id WHERE r.request_id=NEW.enrollment_request_id AND a.receipt_id=NEW.enrollment_receipt_id AND r.action='remote.principal.enroll' AND r.state='approved' AND a.decision='approve' AND r.requested_by='local-owner' AND a.signer_principal_id=r.requested_by AND a.authenticated_session_id=NEW.local_owner_session_id AND NEW.local_owner_session_id='session:local-owner' AND json_extract(r.target_json,'$.principal_id')=NEW.principal_id AND json_extract(r.target_json,'$.subject_digest')=NEW.subject_digest AND json_extract(r.target_json,'$.public_key_digest')=NEW.credential_public_key_digest AND json_extract(r.target_json,'$.target_digest')=NEW.target_digest AND json_extract(r.args_json,'$.operation')='enroll' AND json_extract(r.args_json,'$.args_digest')=NEW.args_digest AND json_extract(r.args_json,'$.local_owner_session_id')=NEW.local_owner_session_id AND json_extract(a.payload_json,'$.receipt_digest')=NEW.enrollment_receipt_digest AND NOT EXISTS (SELECT 1 FROM personal_authority_redemptions WHERE receipt_id=a.receipt_id OR request_id=r.request_id) AND julianday(NEW.activated_at)<julianday(r.expires_at) AND julianday(NEW.activated_at)<julianday(a.expires_at) AND julianday(NEW.enrollment_expires_at)<=julianday(r.expires_at) AND julianday(NEW.enrollment_expires_at)<=julianday(a.expires_at)) BEGIN SELECT RAISE(ABORT,'remote principal enrollment required'); END;
CREATE TRIGGER remote_principal_redeem AFTER UPDATE OF state ON remote_principals WHEN OLD.state='absent' AND NEW.state='active' BEGIN INSERT INTO personal_authority_redemptions(receipt_id,request_id,authority_kind,subject_id,binding_digest,consumed_at) VALUES(NEW.enrollment_receipt_id,NEW.enrollment_request_id,'remote_enrollment',NEW.principal_id,NEW.enrollment_receipt_digest,NEW.activated_at); END;
CREATE TRIGGER remote_principals_identity_immutable BEFORE UPDATE OF principal_id,subject_digest,credential_public_key_digest,target_digest,args_digest,local_owner_session_id,enrollment_request_id,enrollment_receipt_id,enrollment_receipt_digest,enrollment_expires_at,activated_at,created_at ON remote_principals WHEN OLD.state<>'absent' BEGIN SELECT RAISE(ABORT,'immutable remote principal identity'); END;
CREATE TRIGGER remote_principals_transition BEFORE UPDATE OF state ON remote_principals WHEN OLD.state<>NEW.state AND OLD.state||':'||NEW.state NOT IN ('absent:active','active:revoked') BEGIN SELECT RAISE(ABORT,'remote principal transition invalid'); END;
CREATE TRIGGER remote_principal_reject_challenges AFTER UPDATE OF state ON remote_principals WHEN NEW.state='revoked' BEGIN UPDATE webauthn_challenges SET state='rejected' WHERE principal_id=NEW.principal_id AND state='issued'; END;
CREATE TRIGGER webauthn_credential_principal_guard BEFORE INSERT ON webauthn_credentials WHEN NOT EXISTS (SELECT 1 FROM remote_principals WHERE principal_id=NEW.principal_id AND state='active' AND credential_public_key_digest=NEW.public_key_digest) BEGIN SELECT RAISE(ABORT,'webauthn credential principal inactive'); END;
CREATE TRIGGER webauthn_credentials_identity_immutable BEFORE UPDATE OF credential_id,principal_id,public_key_cose,public_key_digest,rp_id,origin,created_at ON webauthn_credentials BEGIN SELECT RAISE(ABORT,'immutable webauthn credential identity'); END;
CREATE TRIGGER webauthn_credential_counter_guard BEFORE UPDATE OF sign_count ON webauthn_credentials WHEN NEW.sign_count<>OLD.sign_count AND NOT EXISTS (SELECT 1 FROM webauthn_assertions WHERE credential_id=OLD.credential_id AND sign_count=NEW.sign_count) BEGIN SELECT RAISE(ABORT,'webauthn assertion counter required'); END;
CREATE TRIGGER webauthn_credentials_transition BEFORE UPDATE OF state ON webauthn_credentials WHEN OLD.state<>NEW.state AND NOT (OLD.state='active' AND NEW.state='revoked') BEGIN SELECT RAISE(ABORT,'webauthn credential transition invalid'); END;
CREATE TRIGGER webauthn_credential_reject_challenges AFTER UPDATE OF state ON webauthn_credentials WHEN NEW.state='revoked' BEGIN UPDATE webauthn_challenges SET state='rejected' WHERE credential_id=NEW.credential_id AND state='issued'; END;
CREATE TRIGGER webauthn_challenge_guard BEFORE INSERT ON webauthn_challenges WHEN NOT EXISTS (SELECT 1 FROM remote_principals p JOIN webauthn_credentials k ON k.principal_id=p.principal_id JOIN control_command_requests r ON r.request_id=NEW.command_request_id WHERE p.principal_id=NEW.principal_id AND p.state='active' AND k.credential_id=NEW.credential_id AND k.state='active' AND k.rp_id=NEW.rp_id AND k.origin=NEW.origin AND r.state='approved' AND r.command_digest=NEW.command_digest AND json_extract(r.target_json,'$.target_digest')=NEW.target_digest AND json_extract(r.args_json,'$.args_digest')=NEW.args_digest AND julianday(NEW.expires_at)<=julianday(r.expires_at)) BEGIN SELECT RAISE(ABORT,'remote challenge binding invalid'); END;
CREATE TRIGGER webauthn_challenges_identity_immutable BEFORE UPDATE OF challenge_id,command_request_id,principal_id,credential_id,session_id,command_digest,target_digest,args_digest,challenge_digest,nonce_digest,rp_id,origin,issued_at,expires_at ON webauthn_challenges BEGIN SELECT RAISE(ABORT,'immutable webauthn challenge identity'); END;
CREATE TRIGGER webauthn_challenge_consumption_guard BEFORE UPDATE OF state ON webauthn_challenges WHEN NEW.state='consumed' AND NOT EXISTS (SELECT 1 FROM webauthn_assertions WHERE challenge_id=OLD.challenge_id AND asserted_at=NEW.consumed_at) BEGIN SELECT RAISE(ABORT,'webauthn assertion required'); END;
CREATE TRIGGER webauthn_challenges_transition BEFORE UPDATE OF state ON webauthn_challenges WHEN OLD.state<>NEW.state AND NOT (OLD.state='issued' AND NEW.state IN ('consumed','expired','rejected')) BEGIN SELECT RAISE(ABORT,'webauthn challenge transition invalid'); END;
CREATE TRIGGER webauthn_assertion_available_guard BEFORE INSERT ON webauthn_assertions WHEN NOT EXISTS (SELECT 1 FROM webauthn_challenges WHERE challenge_id=NEW.challenge_id AND state='issued') BEGIN SELECT RAISE(ABORT,'webauthn challenge unavailable'); END;
CREATE TRIGGER webauthn_assertion_expiry_guard BEFORE INSERT ON webauthn_assertions WHEN EXISTS (SELECT 1 FROM webauthn_challenges WHERE challenge_id=NEW.challenge_id AND julianday(expires_at)<=julianday(NEW.asserted_at)) BEGIN SELECT RAISE(ABORT,'webauthn challenge expired'); END;
CREATE TRIGGER webauthn_assertion_binding_guard BEFORE INSERT ON webauthn_assertions WHEN EXISTS (SELECT 1 FROM webauthn_challenges WHERE challenge_id=NEW.challenge_id AND state='issued' AND julianday(expires_at)>julianday(NEW.asserted_at)) AND NOT EXISTS (SELECT 1 FROM webauthn_challenges c JOIN remote_principals p ON p.principal_id=c.principal_id JOIN webauthn_credentials k ON k.credential_id=c.credential_id WHERE c.challenge_id=NEW.challenge_id AND c.principal_id=NEW.principal_id AND c.credential_id=NEW.credential_id AND c.session_id=NEW.session_id AND c.command_digest=NEW.command_digest AND c.target_digest=NEW.target_digest AND c.args_digest=NEW.args_digest AND c.nonce_digest=NEW.nonce_digest AND c.rp_id=NEW.rp_id AND c.origin=NEW.origin AND p.state='active' AND k.state='active' AND k.principal_id=NEW.principal_id AND NEW.sign_count>k.sign_count AND NEW.user_verified=1 AND julianday(c.issued_at)<=julianday(NEW.asserted_at) AND julianday(NEW.asserted_at)<julianday(c.expires_at)) BEGIN SELECT RAISE(ABORT,'webauthn assertion binding mismatch'); END;
CREATE TRIGGER webauthn_assertion_consume AFTER INSERT ON webauthn_assertions BEGIN UPDATE webauthn_challenges SET state='consumed',consumed_at=NEW.asserted_at WHERE challenge_id=NEW.challenge_id AND state='issued'; UPDATE webauthn_credentials SET sign_count=NEW.sign_count WHERE credential_id=NEW.credential_id AND sign_count<NEW.sign_count; END;
CREATE TRIGGER webauthn_assertions_immutable_update BEFORE UPDATE ON webauthn_assertions BEGIN SELECT RAISE(ABORT,'immutable webauthn assertion'); END;
CREATE TRIGGER webauthn_assertions_immutable_delete BEFORE DELETE ON webauthn_assertions BEGIN SELECT RAISE(ABORT,'immutable webauthn assertion'); END;

CREATE TRIGGER retention_jobs_initial_state BEFORE INSERT ON retention_jobs WHEN NEW.state<>'pending' BEGIN SELECT RAISE(ABORT,'retention must start pending'); END;
CREATE TRIGGER retention_jobs_identity_immutable BEFORE UPDATE OF job_id,job_key,idempotency_key,data_class,not_before,expires_at,created_at ON retention_jobs BEGIN SELECT RAISE(ABORT,'immutable retention job identity'); END;
CREATE TRIGGER retention_jobs_transition BEFORE UPDATE OF state ON retention_jobs WHEN OLD.state<>NEW.state AND OLD.state||':'||NEW.state NOT IN ('pending:claimed','pending:failed','claimed:completed','claimed:failed','claimed:uncertain') BEGIN SELECT RAISE(ABORT,'retention transition invalid'); END;
CREATE TRIGGER retention_jobs_claim_guard BEFORE UPDATE OF lease_fence ON retention_jobs WHEN OLD.lease_fence=0 AND NOT (NEW.lease_fence=1 AND OLD.state='pending' AND NEW.state='claimed' AND NEW.lease_owner IS NOT NULL AND julianday(NEW.lease_expires_at)>julianday(NEW.updated_at) AND julianday(NEW.lease_expires_at)<=julianday(NEW.expires_at)) BEGIN SELECT RAISE(ABORT,'retention claim invalid'); END;
CREATE TRIGGER retention_jobs_reclaim_guard BEFORE UPDATE OF lease_fence ON retention_jobs WHEN OLD.lease_fence>0 AND NEW.lease_fence<>OLD.lease_fence AND julianday(OLD.lease_expires_at)<=julianday(NEW.updated_at) AND NOT (NEW.lease_fence=OLD.lease_fence+1 AND NEW.lease_owner IS NOT NULL AND NEW.lease_owner<>OLD.lease_owner AND julianday(OLD.lease_expires_at)<=julianday(NEW.updated_at) AND julianday(NEW.lease_expires_at)>julianday(NEW.updated_at) AND julianday(NEW.lease_expires_at)<=julianday(NEW.expires_at) AND NEW.state=OLD.state) BEGIN SELECT RAISE(ABORT,'retention reclaim invalid'); END;
CREATE TRIGGER retention_jobs_active_lease BEFORE UPDATE OF lease_owner,lease_fence ON retention_jobs WHEN OLD.lease_owner IS NOT NULL AND ((NEW.lease_owner IS NOT NULL AND NEW.lease_owner IS NOT OLD.lease_owner) OR NEW.lease_fence<>OLD.lease_fence) AND julianday(OLD.lease_expires_at)>julianday(NEW.updated_at) BEGIN SELECT RAISE(ABORT,'retention active lease exists'); END;
CREATE TRIGGER retention_jobs_lease_expiry_guard BEFORE UPDATE OF lease_expires_at ON retention_jobs WHEN NEW.lease_owner IS NOT NULL AND (julianday(NEW.lease_expires_at)<=julianday(NEW.updated_at) OR julianday(NEW.lease_expires_at)>julianday(NEW.expires_at) OR julianday(NEW.lease_expires_at)>julianday(NEW.updated_at)+15.0/1440.0) BEGIN SELECT RAISE(ABORT,'retention lease expiry invalid'); END;

CREATE TRIGGER personal_operation_audit_immutable_update BEFORE UPDATE ON personal_operation_audit_events BEGIN SELECT RAISE(ABORT,'immutable personal operation audit'); END;
CREATE TRIGGER personal_operation_audit_immutable_delete BEFORE DELETE ON personal_operation_audit_events BEGIN SELECT RAISE(ABORT,'immutable personal operation audit'); END;
