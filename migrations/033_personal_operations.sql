-- allow: SIZE_OK - indivisible forward migration for one personal-operations schema boundary.
CREATE TABLE daily_loop_runs (
  run_id TEXT PRIMARY KEY CHECK(length(run_id) BETWEEN 1 AND 256),
  loop_date TEXT NOT NULL,
  correlation_id TEXT NOT NULL UNIQUE,
  idempotency_key TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL CHECK(state IN ('pending','claimed','running','verifying','completed','failed','uncertain')),
  lease_owner TEXT,
  lease_fence INTEGER NOT NULL DEFAULT 0 CHECK(lease_fence >= 0),
  lease_expires_at TEXT,
  expires_at TEXT NOT NULL,
  result_digest TEXT CHECK(result_digest IS NULL OR (length(result_digest)=71 AND result_digest LIKE 'sha256:%')),
  failure_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK(expires_at > created_at),
  CHECK((lease_owner IS NULL AND lease_expires_at IS NULL) OR (lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL AND lease_fence > 0)),
  CHECK(state NOT IN ('claimed','running','verifying') OR (lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL))
);
CREATE INDEX daily_loop_runs_state ON daily_loop_runs(state,loop_date,run_id);
CREATE INDEX daily_loop_runs_lease ON daily_loop_runs(lease_expires_at,run_id) WHERE lease_owner IS NOT NULL;

CREATE TABLE daily_loop_steps (
  step_id TEXT PRIMARY KEY CHECK(length(step_id) BETWEEN 1 AND 256),
  run_id TEXT NOT NULL REFERENCES daily_loop_runs(run_id),
  sequence INTEGER NOT NULL CHECK(sequence > 0),
  step_key TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('pending','claimed','running','verifying','completed','failed','uncertain')),
  evidence_digest TEXT CHECK(evidence_digest IS NULL OR (length(evidence_digest)=71 AND evidence_digest LIKE 'sha256:%')),
  result_digest TEXT CHECK(result_digest IS NULL OR (length(result_digest)=71 AND result_digest LIKE 'sha256:%')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(run_id,sequence),
  UNIQUE(run_id,step_key)
);
CREATE INDEX daily_loop_steps_state ON daily_loop_steps(run_id,state,sequence);

CREATE TABLE daily_loop_checkpoints (
  checkpoint_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES daily_loop_runs(run_id),
  step_id TEXT REFERENCES daily_loop_steps(step_id),
  sequence INTEGER NOT NULL CHECK(sequence > 0),
  state TEXT NOT NULL CHECK(state IN ('pending','claimed','running','verifying','completed','failed','uncertain')),
  previous_digest TEXT CHECK(previous_digest IS NULL OR (length(previous_digest)=71 AND previous_digest LIKE 'sha256:%')),
  checkpoint_digest TEXT NOT NULL CHECK(length(checkpoint_digest)=71 AND checkpoint_digest LIKE 'sha256:%'),
  lease_fence INTEGER NOT NULL CHECK(lease_fence > 0),
  lease_expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(run_id,sequence),
  UNIQUE(checkpoint_digest)
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
  state TEXT NOT NULL CHECK(state IN ('proposed','ready','delivering','delivered','failed','expired')),
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK(expires_at > created_at)
);
CREATE INDEX notification_intents_state ON notification_intents(state,expires_at,intent_id);

CREATE TABLE notification_deliveries (
  delivery_id TEXT PRIMARY KEY,
  intent_id TEXT NOT NULL REFERENCES notification_intents(intent_id),
  idempotency_key TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL CHECK(state IN ('proposed','ready','delivering','delivered','failed','expired')),
  lease_owner TEXT,
  lease_fence INTEGER NOT NULL DEFAULT 0 CHECK(lease_fence >= 0),
  lease_expires_at TEXT,
  attempt_digest TEXT CHECK(attempt_digest IS NULL OR (length(attempt_digest)=71 AND attempt_digest LIKE 'sha256:%')),
  receipt_digest TEXT UNIQUE CHECK(receipt_digest IS NULL OR (length(receipt_digest)=71 AND receipt_digest LIKE 'sha256:%')),
  delivered_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(intent_id,idempotency_key),
  CHECK((lease_owner IS NULL AND lease_expires_at IS NULL) OR (lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL AND lease_fence > 0)),
  CHECK(state <> 'delivering' OR (lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL))
);
CREATE INDEX notification_deliveries_state ON notification_deliveries(state,lease_expires_at,delivery_id);

CREATE TABLE memory_candidates (
  candidate_id TEXT PRIMARY KEY,
  correlation_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  candidate_kind TEXT NOT NULL CHECK(candidate_kind IN ('verified_fact','user_instruction','inference','correction','forget')),
  operation TEXT NOT NULL CHECK(operation IN ('remember','correct','forget','export')),
  subject_digest TEXT NOT NULL CHECK(length(subject_digest)=71 AND subject_digest LIKE 'sha256:%'),
  content_digest TEXT NOT NULL CHECK(length(content_digest)=71 AND content_digest LIKE 'sha256:%'),
  source_digest TEXT NOT NULL CHECK(length(source_digest)=71 AND source_digest LIKE 'sha256:%'),
  sensitivity TEXT NOT NULL CHECK(sensitivity IN ('normal','sensitive','restricted')),
  purpose TEXT NOT NULL,
  required_confirmation INTEGER NOT NULL CHECK(required_confirmation IN (0,1)),
  state TEXT NOT NULL CHECK(state IN ('proposed','classified','awaiting_confirmation','approved','rejected','queued','delivering','settled','failed','uncertain')),
  confirmation_expires_at TEXT,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK(expires_at > created_at),
  CHECK(required_confirmation=0 OR confirmation_expires_at IS NOT NULL)
);
CREATE INDEX memory_candidates_state ON memory_candidates(state,expires_at,candidate_id);
CREATE INDEX memory_candidates_subject ON memory_candidates(subject_digest,created_at,candidate_id);

CREATE TABLE memory_outbox (
  outbox_id TEXT PRIMARY KEY,
  candidate_id TEXT NOT NULL UNIQUE REFERENCES memory_candidates(candidate_id),
  idempotency_key TEXT NOT NULL UNIQUE,
  operation TEXT NOT NULL CHECK(operation IN ('remember','correct','forget','export')),
  request_digest TEXT NOT NULL CHECK(length(request_digest)=71 AND request_digest LIKE 'sha256:%'),
  expected_artifact_digest TEXT NOT NULL CHECK(length(expected_artifact_digest)=71 AND expected_artifact_digest LIKE 'sha256:%'),
  state TEXT NOT NULL CHECK(state IN ('queued','delivering','settled','failed','uncertain')),
  lease_owner TEXT,
  lease_fence INTEGER NOT NULL DEFAULT 0 CHECK(lease_fence >= 0),
  lease_expires_at TEXT,
  expires_at TEXT NOT NULL,
  settled_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK(expires_at > created_at),
  CHECK((lease_owner IS NULL AND lease_expires_at IS NULL) OR (lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL AND lease_fence > 0)),
  CHECK(state <> 'delivering' OR (lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL))
);
CREATE INDEX memory_outbox_state ON memory_outbox(state,lease_expires_at,outbox_id);

CREATE TABLE memory_outbox_attempts (
  attempt_id TEXT PRIMARY KEY,
  outbox_id TEXT NOT NULL REFERENCES memory_outbox(outbox_id),
  lease_fence INTEGER NOT NULL CHECK(lease_fence > 0),
  invocation_digest TEXT NOT NULL UNIQUE CHECK(length(invocation_digest)=71 AND invocation_digest LIKE 'sha256:%'),
  outcome TEXT NOT NULL CHECK(outcome IN ('accepted','rejected','failed','uncertain')),
  error_code TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(outbox_id,lease_fence)
);
CREATE INDEX memory_outbox_attempts_outbox ON memory_outbox_attempts(outbox_id,created_at,attempt_id);

CREATE TABLE memory_reconciliation_events (
  event_id TEXT PRIMARY KEY,
  outbox_id TEXT NOT NULL REFERENCES memory_outbox(outbox_id),
  attempt_id TEXT REFERENCES memory_outbox_attempts(attempt_id),
  event_type TEXT NOT NULL CHECK(event_type IN ('accepted','artifact_observed','artifact_missing','conflict','uncertain')),
  observed_artifact_digest TEXT CHECK(observed_artifact_digest IS NULL OR (length(observed_artifact_digest)=71 AND observed_artifact_digest LIKE 'sha256:%')),
  effect_digest TEXT NOT NULL UNIQUE CHECK(length(effect_digest)=71 AND effect_digest LIKE 'sha256:%'),
  created_at TEXT NOT NULL
);
CREATE INDEX memory_reconciliation_outbox ON memory_reconciliation_events(outbox_id,created_at,event_id);

CREATE TABLE memory_deletion_requests (
  deletion_id TEXT PRIMARY KEY,
  correlation_id TEXT NOT NULL UNIQUE,
  idempotency_key TEXT NOT NULL UNIQUE,
  subject_digest TEXT NOT NULL CHECK(length(subject_digest)=71 AND subject_digest LIKE 'sha256:%'),
  scope_digest TEXT NOT NULL CHECK(length(scope_digest)=71 AND scope_digest LIKE 'sha256:%'),
  state TEXT NOT NULL CHECK(state IN ('requested','approved','queued','applying','tombstoned','purging','verifying','settled','failed','uncertain')),
  confirmation_request_id TEXT REFERENCES control_command_requests(request_id),
  confirmation_receipt_id TEXT UNIQUE REFERENCES control_command_receipts(receipt_id),
  lease_owner TEXT,
  lease_fence INTEGER NOT NULL DEFAULT 0 CHECK(lease_fence >= 0),
  lease_expires_at TEXT,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK(expires_at > created_at),
  CHECK((confirmation_request_id IS NULL AND confirmation_receipt_id IS NULL) OR (confirmation_request_id IS NOT NULL AND confirmation_receipt_id IS NOT NULL)),
  CHECK((lease_owner IS NULL AND lease_expires_at IS NULL) OR (lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL AND lease_fence > 0)),
  CHECK(state <> 'applying' OR (lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL))
);
CREATE INDEX memory_deletion_state ON memory_deletion_requests(state,expires_at,deletion_id);
CREATE INDEX memory_deletion_subject ON memory_deletion_requests(subject_digest,created_at,deletion_id);

CREATE TABLE memory_tombstones (
  tombstone_id TEXT PRIMARY KEY,
  deletion_id TEXT NOT NULL UNIQUE REFERENCES memory_deletion_requests(deletion_id),
  subject_digest TEXT NOT NULL UNIQUE CHECK(length(subject_digest)=71 AND subject_digest LIKE 'sha256:%'),
  scope_digest TEXT NOT NULL CHECK(length(scope_digest)=71 AND scope_digest LIKE 'sha256:%'),
  approval_receipt_id TEXT NOT NULL REFERENCES control_command_receipts(receipt_id),
  effective_at TEXT NOT NULL,
  tombstone_digest TEXT NOT NULL UNIQUE CHECK(length(tombstone_digest)=71 AND tombstone_digest LIKE 'sha256:%'),
  created_at TEXT NOT NULL
);
CREATE INDEX memory_tombstones_effective ON memory_tombstones(effective_at,tombstone_id);

CREATE TABLE remote_principals (
  principal_id TEXT PRIMARY KEY,
  state TEXT NOT NULL CHECK(state IN ('absent','active','revoked')),
  subject_digest TEXT NOT NULL CHECK(length(subject_digest)=71 AND subject_digest LIKE 'sha256:%'),
  enrollment_request_id TEXT REFERENCES control_command_requests(request_id),
  enrollment_receipt_id TEXT UNIQUE REFERENCES control_command_receipts(receipt_id),
  enrollment_receipt_digest TEXT CHECK(enrollment_receipt_digest IS NULL OR (length(enrollment_receipt_digest)=71 AND enrollment_receipt_digest LIKE 'sha256:%')),
  enrollment_expires_at TEXT,
  activated_at TEXT,
  revoked_at TEXT,
  created_at TEXT NOT NULL,
  CHECK((state='absent' AND enrollment_request_id IS NULL AND enrollment_receipt_id IS NULL AND enrollment_receipt_digest IS NULL AND enrollment_expires_at IS NULL AND activated_at IS NULL AND revoked_at IS NULL)
     OR (state='active' AND enrollment_request_id IS NOT NULL AND enrollment_receipt_id IS NOT NULL AND enrollment_receipt_digest IS NOT NULL AND enrollment_expires_at IS NOT NULL AND activated_at IS NOT NULL AND revoked_at IS NULL)
     OR (state='revoked' AND revoked_at IS NOT NULL))
);
CREATE INDEX remote_principals_state ON remote_principals(state,principal_id);

CREATE TABLE webauthn_credentials (
  credential_id TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL REFERENCES remote_principals(principal_id),
  public_key_cose TEXT NOT NULL,
  public_key_digest TEXT NOT NULL UNIQUE CHECK(length(public_key_digest)=71 AND public_key_digest LIKE 'sha256:%'),
  sign_count INTEGER NOT NULL DEFAULT 0 CHECK(sign_count >= 0),
  state TEXT NOT NULL CHECK(state IN ('active','revoked')),
  rp_id TEXT NOT NULL,
  origin TEXT NOT NULL,
  created_at TEXT NOT NULL,
  revoked_at TEXT,
  CHECK((state='active' AND revoked_at IS NULL) OR (state='revoked' AND revoked_at IS NOT NULL))
);
CREATE INDEX webauthn_credentials_principal ON webauthn_credentials(principal_id,state,credential_id);

CREATE TABLE webauthn_challenges (
  challenge_id TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL REFERENCES remote_principals(principal_id),
  credential_id TEXT NOT NULL REFERENCES webauthn_credentials(credential_id),
  session_id TEXT NOT NULL,
  command_digest TEXT NOT NULL CHECK(length(command_digest)=71 AND command_digest LIKE 'sha256:%'),
  target_digest TEXT NOT NULL CHECK(length(target_digest)=71 AND target_digest LIKE 'sha256:%'),
  args_digest TEXT NOT NULL CHECK(length(args_digest)=71 AND args_digest LIKE 'sha256:%'),
  challenge_digest TEXT NOT NULL UNIQUE CHECK(length(challenge_digest)=71 AND challenge_digest LIKE 'sha256:%'),
  nonce_digest TEXT NOT NULL UNIQUE CHECK(length(nonce_digest)=71 AND nonce_digest LIKE 'sha256:%'),
  rp_id TEXT NOT NULL,
  origin TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('issued','consumed','expired','rejected')),
  issued_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  CHECK(expires_at > issued_at),
  CHECK(julianday(expires_at)-julianday(issued_at) <= 15.0/1440.0),
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
  command_digest TEXT NOT NULL CHECK(length(command_digest)=71 AND command_digest LIKE 'sha256:%'),
  assertion_digest TEXT NOT NULL UNIQUE CHECK(length(assertion_digest)=71 AND assertion_digest LIKE 'sha256:%'),
  sign_count INTEGER NOT NULL CHECK(sign_count > 0),
  user_verified INTEGER NOT NULL CHECK(user_verified=1),
  asserted_at TEXT NOT NULL
);
CREATE INDEX webauthn_assertions_principal ON webauthn_assertions(principal_id,asserted_at,assertion_id);

CREATE TABLE retention_jobs (
  job_id TEXT PRIMARY KEY,
  job_key TEXT NOT NULL UNIQUE,
  idempotency_key TEXT NOT NULL UNIQUE,
  data_class TEXT NOT NULL CHECK(data_class IN ('observation','context','recommendation','notification','memory_candidate','audit','delete')),
  state TEXT NOT NULL CHECK(state IN ('pending','claimed','completed','failed','uncertain')),
  lease_owner TEXT,
  lease_fence INTEGER NOT NULL DEFAULT 0 CHECK(lease_fence >= 0),
  lease_expires_at TEXT,
  not_before TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  result_digest TEXT CHECK(result_digest IS NULL OR (length(result_digest)=71 AND result_digest LIKE 'sha256:%')),
  failure_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK(expires_at > not_before),
  CHECK((lease_owner IS NULL AND lease_expires_at IS NULL) OR (lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL AND lease_fence > 0)),
  CHECK(state <> 'claimed' OR (lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL))
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
  event_digest TEXT NOT NULL UNIQUE CHECK(length(event_digest)=71 AND event_digest LIKE 'sha256:%'),
  created_at TEXT NOT NULL
);
CREATE INDEX personal_operation_audit_subject ON personal_operation_audit_events(subject_kind,subject_id,created_at,event_id);
CREATE INDEX personal_operation_audit_correlation ON personal_operation_audit_events(correlation_id,created_at,event_id);

CREATE TRIGGER daily_loop_runs_initial_state BEFORE INSERT ON daily_loop_runs WHEN NEW.state<>'pending' BEGIN SELECT RAISE(ABORT,'daily loop must start pending'); END;
CREATE TRIGGER daily_loop_runs_identity_immutable BEFORE UPDATE OF run_id,loop_date,correlation_id,idempotency_key,expires_at,created_at ON daily_loop_runs BEGIN SELECT RAISE(ABORT,'immutable daily loop identity'); END;
CREATE TRIGGER daily_loop_runs_transition BEFORE UPDATE OF state ON daily_loop_runs WHEN OLD.state<>NEW.state AND NOT (
  (OLD.state='pending' AND NEW.state IN ('claimed','failed')) OR
  (OLD.state='claimed' AND NEW.state IN ('running','failed','uncertain')) OR
  (OLD.state='running' AND NEW.state IN ('verifying','failed','uncertain')) OR
  (OLD.state='verifying' AND NEW.state IN ('completed','failed','uncertain'))
) BEGIN SELECT RAISE(ABORT,'daily loop transition invalid'); END;
CREATE TRIGGER daily_loop_runs_active_lease BEFORE UPDATE OF lease_owner,lease_fence,lease_expires_at ON daily_loop_runs WHEN OLD.lease_owner IS NOT NULL AND OLD.lease_expires_at>NEW.updated_at AND NEW.lease_owner IS NOT NULL AND NEW.lease_owner IS NOT OLD.lease_owner BEGIN SELECT RAISE(ABORT,'daily loop active lease exists'); END;
CREATE TRIGGER daily_loop_runs_stale_fence BEFORE UPDATE ON daily_loop_runs WHEN OLD.lease_fence>0 AND NEW.lease_fence<>OLD.lease_fence AND NOT (OLD.lease_owner IS NULL AND OLD.state='pending' AND NEW.state='claimed' AND NEW.lease_fence=OLD.lease_fence+1) BEGIN SELECT RAISE(ABORT,'daily loop stale fence'); END;
CREATE TRIGGER daily_loop_steps_initial_state BEFORE INSERT ON daily_loop_steps WHEN NEW.state<>'pending' BEGIN SELECT RAISE(ABORT,'daily loop step must start pending'); END;
CREATE TRIGGER daily_loop_steps_transition BEFORE UPDATE OF state ON daily_loop_steps WHEN OLD.state<>NEW.state AND NOT ((OLD.state='pending' AND NEW.state IN ('claimed','failed')) OR (OLD.state='claimed' AND NEW.state IN ('running','failed','uncertain')) OR (OLD.state='running' AND NEW.state IN ('verifying','failed','uncertain')) OR (OLD.state='verifying' AND NEW.state IN ('completed','failed','uncertain'))) BEGIN SELECT RAISE(ABORT,'daily loop step transition invalid'); END;
CREATE TRIGGER daily_loop_checkpoints_immutable_update BEFORE UPDATE ON daily_loop_checkpoints BEGIN SELECT RAISE(ABORT,'immutable daily loop checkpoint'); END;
CREATE TRIGGER daily_loop_checkpoints_immutable_delete BEFORE DELETE ON daily_loop_checkpoints BEGIN SELECT RAISE(ABORT,'immutable daily loop checkpoint'); END;

CREATE TRIGGER notification_intents_initial_state BEFORE INSERT ON notification_intents WHEN NEW.state<>'proposed' BEGIN SELECT RAISE(ABORT,'notification must start proposed'); END;
CREATE TRIGGER notification_intents_identity_immutable BEFORE UPDATE OF intent_id,correlation_id,idempotency_key,dedup_key,urgency,channel,redacted_preview,deep_link,expires_at,created_at ON notification_intents BEGIN SELECT RAISE(ABORT,'immutable notification intent identity'); END;
CREATE TRIGGER notification_intents_transition BEFORE UPDATE OF state ON notification_intents WHEN OLD.state<>NEW.state AND NOT ((OLD.state='proposed' AND NEW.state IN ('ready','failed','expired')) OR (OLD.state='ready' AND NEW.state IN ('delivering','failed','expired')) OR (OLD.state='delivering' AND NEW.state IN ('delivered','failed','expired'))) BEGIN SELECT RAISE(ABORT,'notification transition invalid'); END;
CREATE TRIGGER notification_deliveries_initial_state BEFORE INSERT ON notification_deliveries WHEN NEW.state<>'proposed' BEGIN SELECT RAISE(ABORT,'notification delivery must start proposed'); END;
CREATE TRIGGER notification_deliveries_transition BEFORE UPDATE OF state ON notification_deliveries WHEN OLD.state<>NEW.state AND NOT ((OLD.state='proposed' AND NEW.state IN ('ready','failed','expired')) OR (OLD.state='ready' AND NEW.state IN ('delivering','failed','expired')) OR (OLD.state='delivering' AND NEW.state IN ('delivered','failed','expired'))) BEGIN SELECT RAISE(ABORT,'notification delivery transition invalid'); END;
CREATE TRIGGER notification_deliveries_identity_immutable BEFORE UPDATE OF delivery_id,intent_id,idempotency_key,attempt_digest,created_at ON notification_deliveries BEGIN SELECT RAISE(ABORT,'immutable notification delivery identity'); END;
CREATE TRIGGER notification_deliveries_active_lease BEFORE UPDATE OF lease_owner,lease_fence,lease_expires_at ON notification_deliveries WHEN OLD.lease_owner IS NOT NULL AND OLD.lease_expires_at>NEW.updated_at AND NEW.lease_owner IS NOT NULL AND NEW.lease_owner IS NOT OLD.lease_owner BEGIN SELECT RAISE(ABORT,'notification active lease exists'); END;
CREATE TRIGGER notification_deliveries_stale_fence BEFORE UPDATE ON notification_deliveries WHEN OLD.lease_fence>0 AND NEW.lease_fence<>OLD.lease_fence BEGIN SELECT RAISE(ABORT,'notification stale fence'); END;

CREATE TRIGGER memory_candidates_initial_state BEFORE INSERT ON memory_candidates WHEN NEW.state<>'proposed' BEGIN SELECT RAISE(ABORT,'memory candidate must start proposed'); END;
CREATE TRIGGER memory_candidates_identity_immutable BEFORE UPDATE OF candidate_id,correlation_id,idempotency_key,candidate_kind,operation,subject_digest,content_digest,source_digest,sensitivity,purpose,required_confirmation,expires_at,created_at ON memory_candidates BEGIN SELECT RAISE(ABORT,'immutable memory candidate identity'); END;
CREATE TRIGGER memory_candidates_transition BEFORE UPDATE OF state ON memory_candidates WHEN OLD.state<>NEW.state AND NOT (
  (OLD.state='proposed' AND NEW.state IN ('classified','rejected','failed')) OR
  (OLD.state='classified' AND NEW.state IN ('awaiting_confirmation','approved','rejected','failed')) OR
  (OLD.state='awaiting_confirmation' AND NEW.state IN ('approved','rejected','failed')) OR
  (OLD.state='approved' AND NEW.state IN ('queued','rejected','failed')) OR
  (OLD.state='queued' AND NEW.state IN ('delivering','failed','uncertain')) OR
  (OLD.state='delivering' AND NEW.state IN ('settled','failed','uncertain'))
) BEGIN SELECT RAISE(ABORT,'memory candidate transition invalid'); END;
CREATE TRIGGER memory_outbox_candidate_guard BEFORE INSERT ON memory_outbox WHEN NOT EXISTS (SELECT 1 FROM memory_candidates WHERE candidate_id=NEW.candidate_id AND state IN ('approved','queued') AND operation=NEW.operation AND expires_at>NEW.created_at) BEGIN SELECT RAISE(ABORT,'memory candidate approval required'); END;
CREATE TRIGGER memory_outbox_queue_candidate AFTER INSERT ON memory_outbox BEGIN UPDATE memory_candidates SET state='queued',updated_at=NEW.created_at WHERE candidate_id=NEW.candidate_id AND state='approved'; END;
CREATE TRIGGER memory_outbox_identity_immutable BEFORE UPDATE OF outbox_id,candidate_id,idempotency_key,operation,request_digest,expected_artifact_digest,expires_at,created_at ON memory_outbox BEGIN SELECT RAISE(ABORT,'immutable memory outbox identity'); END;
CREATE TRIGGER memory_outbox_transition BEFORE UPDATE OF state ON memory_outbox WHEN OLD.state<>NEW.state AND NOT ((OLD.state='queued' AND NEW.state IN ('delivering','failed','uncertain')) OR (OLD.state='delivering' AND NEW.state IN ('settled','failed','uncertain'))) BEGIN SELECT RAISE(ABORT,'memory outbox transition invalid'); END;
CREATE TRIGGER memory_outbox_active_lease BEFORE UPDATE OF lease_owner,lease_fence,lease_expires_at ON memory_outbox WHEN OLD.lease_owner IS NOT NULL AND OLD.lease_expires_at>NEW.updated_at AND NEW.lease_owner IS NOT NULL AND NEW.lease_owner IS NOT OLD.lease_owner BEGIN SELECT RAISE(ABORT,'memory outbox active lease exists'); END;
CREATE TRIGGER memory_outbox_stale_fence BEFORE UPDATE ON memory_outbox WHEN OLD.lease_fence>0 AND NEW.lease_fence<>OLD.lease_fence BEGIN SELECT RAISE(ABORT,'memory outbox stale fence'); END;
CREATE TRIGGER memory_outbox_settlement_guard BEFORE UPDATE OF state ON memory_outbox WHEN NEW.state='settled' AND NOT EXISTS (SELECT 1 FROM memory_reconciliation_events WHERE outbox_id=OLD.outbox_id AND event_type='artifact_observed' AND observed_artifact_digest=OLD.expected_artifact_digest) BEGIN SELECT RAISE(ABORT,'memory outbox reconciliation required'); END;
CREATE TRIGGER memory_outbox_attempt_guard BEFORE INSERT ON memory_outbox_attempts WHEN NOT EXISTS (SELECT 1 FROM memory_outbox WHERE outbox_id=NEW.outbox_id AND state='delivering' AND lease_fence=NEW.lease_fence AND lease_expires_at>NEW.created_at) BEGIN SELECT RAISE(ABORT,'memory outbox current fence required'); END;
CREATE TRIGGER memory_outbox_attempts_immutable_update BEFORE UPDATE ON memory_outbox_attempts BEGIN SELECT RAISE(ABORT,'immutable memory outbox attempt'); END;
CREATE TRIGGER memory_outbox_attempts_immutable_delete BEFORE DELETE ON memory_outbox_attempts BEGIN SELECT RAISE(ABORT,'immutable memory outbox attempt'); END;
CREATE TRIGGER memory_reconciliation_immutable_update BEFORE UPDATE ON memory_reconciliation_events BEGIN SELECT RAISE(ABORT,'immutable memory reconciliation event'); END;
CREATE TRIGGER memory_reconciliation_immutable_delete BEFORE DELETE ON memory_reconciliation_events BEGIN SELECT RAISE(ABORT,'immutable memory reconciliation event'); END;

CREATE TRIGGER memory_deletion_identity_immutable BEFORE UPDATE OF deletion_id,correlation_id,idempotency_key,subject_digest,scope_digest,expires_at,created_at ON memory_deletion_requests BEGIN SELECT RAISE(ABORT,'immutable memory deletion identity'); END;
CREATE TRIGGER memory_deletion_transition BEFORE UPDATE OF state ON memory_deletion_requests WHEN OLD.state<>NEW.state AND NOT (
  (OLD.state='requested' AND NEW.state IN ('approved','failed')) OR
  (OLD.state='approved' AND NEW.state IN ('queued','failed')) OR
  (OLD.state='queued' AND NEW.state IN ('applying','failed','uncertain')) OR
  (OLD.state='applying' AND NEW.state IN ('tombstoned','failed','uncertain')) OR
  (OLD.state='tombstoned' AND NEW.state IN ('purging','failed','uncertain')) OR
  (OLD.state='purging' AND NEW.state IN ('verifying','failed','uncertain')) OR
  (OLD.state='verifying' AND NEW.state IN ('settled','failed','uncertain'))
) BEGIN SELECT RAISE(ABORT,'memory deletion transition invalid'); END;
CREATE TRIGGER memory_deletion_approval_guard BEFORE UPDATE OF state ON memory_deletion_requests WHEN NEW.state='approved' AND NOT EXISTS (
  SELECT 1 FROM control_command_requests r JOIN control_command_receipts a ON a.request_id=r.request_id
  WHERE r.request_id=NEW.confirmation_request_id AND a.receipt_id=NEW.confirmation_receipt_id AND r.action='memory.delete' AND r.state='completed' AND a.decision='approve' AND a.command_digest=r.command_digest AND a.signer_principal_id=r.requested_by AND a.expires_at>NEW.updated_at AND r.expires_at>NEW.updated_at
) BEGIN SELECT RAISE(ABORT,'memory deletion approval required'); END;
CREATE TRIGGER memory_deletion_active_lease BEFORE UPDATE OF lease_owner,lease_fence,lease_expires_at ON memory_deletion_requests WHEN OLD.lease_owner IS NOT NULL AND OLD.lease_expires_at>NEW.updated_at AND NEW.lease_owner IS NOT NULL AND NEW.lease_owner IS NOT OLD.lease_owner BEGIN SELECT RAISE(ABORT,'memory deletion active lease exists'); END;
CREATE TRIGGER memory_deletion_stale_fence BEFORE UPDATE ON memory_deletion_requests WHEN OLD.lease_fence>0 AND NEW.lease_fence<>OLD.lease_fence BEGIN SELECT RAISE(ABORT,'memory deletion stale fence'); END;
CREATE TRIGGER memory_deletion_tombstone_guard BEFORE UPDATE OF state ON memory_deletion_requests WHEN NEW.state='tombstoned' AND NOT EXISTS (SELECT 1 FROM memory_tombstones WHERE deletion_id=OLD.deletion_id AND subject_digest=OLD.subject_digest AND scope_digest=OLD.scope_digest AND approval_receipt_id=OLD.confirmation_receipt_id) BEGIN SELECT RAISE(ABORT,'memory tombstone required'); END;
CREATE TRIGGER memory_tombstone_insert_guard BEFORE INSERT ON memory_tombstones WHEN NOT EXISTS (SELECT 1 FROM memory_deletion_requests WHERE deletion_id=NEW.deletion_id AND state='applying' AND subject_digest=NEW.subject_digest AND scope_digest=NEW.scope_digest AND confirmation_receipt_id=NEW.approval_receipt_id) BEGIN SELECT RAISE(ABORT,'memory tombstone authority required'); END;
CREATE TRIGGER memory_tombstones_immutable_update BEFORE UPDATE ON memory_tombstones BEGIN SELECT RAISE(ABORT,'immutable memory tombstone'); END;
CREATE TRIGGER memory_tombstones_immutable_delete BEFORE DELETE ON memory_tombstones BEGIN SELECT RAISE(ABORT,'immutable memory tombstone'); END;

CREATE TRIGGER remote_principal_enrollment_guard BEFORE INSERT ON remote_principals WHEN NEW.state='active' AND NOT EXISTS (
  SELECT 1 FROM control_command_requests r JOIN control_command_receipts a ON a.request_id=r.request_id
  WHERE r.request_id=NEW.enrollment_request_id AND a.receipt_id=NEW.enrollment_receipt_id AND r.action='remote.principal.enroll' AND r.state='completed' AND a.decision='approve' AND a.command_digest=r.command_digest AND a.expires_at>=NEW.enrollment_expires_at AND r.expires_at>=NEW.enrollment_expires_at AND NEW.activated_at<=NEW.enrollment_expires_at
) BEGIN SELECT RAISE(ABORT,'remote principal enrollment required'); END;
CREATE TRIGGER remote_principals_identity_immutable BEFORE UPDATE OF principal_id,subject_digest,enrollment_request_id,enrollment_receipt_id,enrollment_receipt_digest,enrollment_expires_at,activated_at,created_at ON remote_principals BEGIN SELECT RAISE(ABORT,'immutable remote principal identity'); END;
CREATE TRIGGER remote_principals_transition BEFORE UPDATE OF state ON remote_principals WHEN OLD.state<>NEW.state AND NOT (OLD.state='active' AND NEW.state='revoked') BEGIN SELECT RAISE(ABORT,'remote principal transition invalid'); END;
CREATE TRIGGER webauthn_credentials_identity_immutable BEFORE UPDATE OF credential_id,principal_id,public_key_cose,public_key_digest,rp_id,origin,created_at ON webauthn_credentials BEGIN SELECT RAISE(ABORT,'immutable webauthn credential identity'); END;
CREATE TRIGGER webauthn_credential_counter_guard BEFORE UPDATE OF sign_count ON webauthn_credentials WHEN NEW.sign_count<>OLD.sign_count AND NOT EXISTS (SELECT 1 FROM webauthn_assertions WHERE credential_id=OLD.credential_id AND sign_count=NEW.sign_count) BEGIN SELECT RAISE(ABORT,'webauthn assertion counter required'); END;
CREATE TRIGGER webauthn_credentials_transition BEFORE UPDATE OF state ON webauthn_credentials WHEN OLD.state<>NEW.state AND NOT (OLD.state='active' AND NEW.state='revoked') BEGIN SELECT RAISE(ABORT,'webauthn credential transition invalid'); END;
CREATE TRIGGER webauthn_credential_principal_guard BEFORE INSERT ON webauthn_credentials WHEN NOT EXISTS (SELECT 1 FROM remote_principals WHERE principal_id=NEW.principal_id AND state='active') BEGIN SELECT RAISE(ABORT,'webauthn credential principal inactive'); END;
CREATE TRIGGER webauthn_challenge_principal_guard BEFORE INSERT ON webauthn_challenges WHEN NOT EXISTS (SELECT 1 FROM remote_principals WHERE principal_id=NEW.principal_id AND state='active') BEGIN SELECT RAISE(ABORT,'remote challenge principal inactive'); END;
CREATE TRIGGER webauthn_challenge_credential_guard BEFORE INSERT ON webauthn_challenges WHEN NOT EXISTS (SELECT 1 FROM webauthn_credentials WHERE credential_id=NEW.credential_id AND principal_id=NEW.principal_id AND state='active' AND rp_id=NEW.rp_id AND origin=NEW.origin) BEGIN SELECT RAISE(ABORT,'remote challenge credential inactive'); END;
CREATE TRIGGER webauthn_challenges_identity_immutable BEFORE UPDATE OF challenge_id,principal_id,credential_id,session_id,command_digest,target_digest,args_digest,challenge_digest,nonce_digest,rp_id,origin,issued_at,expires_at ON webauthn_challenges BEGIN SELECT RAISE(ABORT,'immutable webauthn challenge identity'); END;
CREATE TRIGGER webauthn_challenge_consumption_guard BEFORE UPDATE OF state ON webauthn_challenges WHEN NEW.state='consumed' AND NOT EXISTS (SELECT 1 FROM webauthn_assertions WHERE challenge_id=OLD.challenge_id AND asserted_at=NEW.consumed_at) BEGIN SELECT RAISE(ABORT,'webauthn assertion required'); END;
CREATE TRIGGER webauthn_challenges_transition BEFORE UPDATE OF state ON webauthn_challenges WHEN OLD.state<>NEW.state AND NOT (OLD.state='issued' AND NEW.state IN ('consumed','expired','rejected')) BEGIN SELECT RAISE(ABORT,'webauthn challenge transition invalid'); END;
CREATE TRIGGER webauthn_assertion_available_guard BEFORE INSERT ON webauthn_assertions WHEN NOT EXISTS (SELECT 1 FROM webauthn_challenges WHERE challenge_id=NEW.challenge_id AND state='issued') BEGIN SELECT RAISE(ABORT,'webauthn challenge unavailable'); END;
CREATE TRIGGER webauthn_assertion_expiry_guard BEFORE INSERT ON webauthn_assertions WHEN EXISTS (SELECT 1 FROM webauthn_challenges WHERE challenge_id=NEW.challenge_id AND expires_at<=NEW.asserted_at) BEGIN SELECT RAISE(ABORT,'webauthn challenge expired'); END;
CREATE TRIGGER webauthn_assertion_binding_guard BEFORE INSERT ON webauthn_assertions WHEN NOT EXISTS (
  SELECT 1 FROM webauthn_challenges c JOIN remote_principals p ON p.principal_id=c.principal_id JOIN webauthn_credentials k ON k.credential_id=c.credential_id
  WHERE c.challenge_id=NEW.challenge_id AND c.principal_id=NEW.principal_id AND c.credential_id=NEW.credential_id AND c.session_id=NEW.session_id AND c.command_digest=NEW.command_digest AND c.issued_at<=NEW.asserted_at AND p.state='active' AND k.state='active' AND k.principal_id=NEW.principal_id AND NEW.sign_count>k.sign_count
) BEGIN SELECT RAISE(ABORT,'webauthn assertion binding mismatch'); END;
CREATE TRIGGER webauthn_assertion_consume AFTER INSERT ON webauthn_assertions BEGIN
  UPDATE webauthn_challenges SET state='consumed',consumed_at=NEW.asserted_at WHERE challenge_id=NEW.challenge_id AND state='issued';
  UPDATE webauthn_credentials SET sign_count=NEW.sign_count WHERE credential_id=NEW.credential_id AND sign_count<NEW.sign_count;
END;
CREATE TRIGGER webauthn_assertions_immutable_update BEFORE UPDATE ON webauthn_assertions BEGIN SELECT RAISE(ABORT,'immutable webauthn assertion'); END;
CREATE TRIGGER webauthn_assertions_immutable_delete BEFORE DELETE ON webauthn_assertions BEGIN SELECT RAISE(ABORT,'immutable webauthn assertion'); END;

CREATE TRIGGER retention_jobs_initial_state BEFORE INSERT ON retention_jobs WHEN NEW.state<>'pending' BEGIN SELECT RAISE(ABORT,'retention must start pending'); END;
CREATE TRIGGER retention_jobs_identity_immutable BEFORE UPDATE OF job_id,job_key,idempotency_key,data_class,not_before,expires_at,created_at ON retention_jobs BEGIN SELECT RAISE(ABORT,'immutable retention job identity'); END;
CREATE TRIGGER retention_jobs_transition BEFORE UPDATE OF state ON retention_jobs WHEN OLD.state<>NEW.state AND NOT ((OLD.state='pending' AND NEW.state IN ('claimed','failed')) OR (OLD.state='claimed' AND NEW.state IN ('completed','failed','uncertain'))) BEGIN SELECT RAISE(ABORT,'retention transition invalid'); END;
CREATE TRIGGER retention_jobs_active_lease BEFORE UPDATE OF lease_owner,lease_fence,lease_expires_at ON retention_jobs WHEN OLD.lease_owner IS NOT NULL AND OLD.lease_expires_at>NEW.updated_at AND NEW.lease_owner IS NOT NULL AND NEW.lease_owner IS NOT OLD.lease_owner BEGIN SELECT RAISE(ABORT,'retention active lease exists'); END;
CREATE TRIGGER retention_jobs_stale_fence BEFORE UPDATE ON retention_jobs WHEN OLD.lease_fence>0 AND NEW.lease_fence<>OLD.lease_fence BEGIN SELECT RAISE(ABORT,'retention stale fence'); END;

CREATE TRIGGER personal_operation_audit_immutable_update BEFORE UPDATE ON personal_operation_audit_events BEGIN SELECT RAISE(ABORT,'immutable personal operation audit'); END;
CREATE TRIGGER personal_operation_audit_immutable_delete BEFORE DELETE ON personal_operation_audit_events BEGIN SELECT RAISE(ABORT,'immutable personal operation audit'); END;
