CREATE TABLE control_command_requests (
  request_id TEXT PRIMARY KEY,
  action TEXT NOT NULL,
  action_level INTEGER NOT NULL CHECK(action_level BETWEEN 0 AND 5),
  target_json TEXT NOT NULL,
  args_json TEXT NOT NULL,
  command_digest TEXT NOT NULL UNIQUE,
  reversible INTEGER NOT NULL CHECK(reversible IN (0,1)),
  requested_by TEXT NOT NULL,
  requested_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  nonce TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL CHECK(state IN ('pending','approved','rejected','claimed','completed','failed','uncertain','cancelled')),
  lease_owner TEXT,
  lease_fence INTEGER NOT NULL DEFAULT 0,
  lease_expires_at TEXT,
  completed_at TEXT,
  failure_code TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX control_command_requests_state ON control_command_requests(state,requested_at,request_id);

CREATE TABLE control_command_receipts (
  receipt_id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL UNIQUE REFERENCES control_command_requests(request_id),
  decision TEXT NOT NULL CHECK(decision IN ('approve','reject')),
  command_digest TEXT NOT NULL,
  signer_principal_id TEXT NOT NULL,
  authenticated_session_id TEXT NOT NULL,
  key_id TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  signature TEXT NOT NULL,
  issued_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE control_command_redemptions (
  receipt_id TEXT PRIMARY KEY REFERENCES control_command_receipts(receipt_id),
  request_id TEXT NOT NULL UNIQUE REFERENCES control_command_requests(request_id),
  lease_fence INTEGER NOT NULL,
  redeemed_at TEXT NOT NULL
);

CREATE TABLE control_command_effects (
  effect_id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL REFERENCES control_command_requests(request_id),
  effect_type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  payload_digest TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE control_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE,
  schema_version INTEGER NOT NULL CHECK(schema_version=1),
  event_type TEXT NOT NULL,
  source TEXT NOT NULL,
  subject TEXT NOT NULL,
  correlation_id TEXT,
  causation_id TEXT,
  payload_json TEXT NOT NULL,
  payload_digest TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX control_events_correlation ON control_events(correlation_id,seq);

CREATE TRIGGER control_request_identity_immutable BEFORE UPDATE OF request_id,action,action_level,target_json,args_json,command_digest,reversible,requested_by,requested_at,expires_at,nonce ON control_command_requests BEGIN SELECT RAISE(ABORT,'immutable control command identity'); END;
CREATE TRIGGER control_receipts_immutable_update BEFORE UPDATE ON control_command_receipts BEGIN SELECT RAISE(ABORT,'immutable control command receipt'); END;
CREATE TRIGGER control_receipts_immutable_delete BEFORE DELETE ON control_command_receipts BEGIN SELECT RAISE(ABORT,'immutable control command receipt'); END;
CREATE TRIGGER control_redemptions_immutable_update BEFORE UPDATE ON control_command_redemptions BEGIN SELECT RAISE(ABORT,'immutable control command redemption'); END;
CREATE TRIGGER control_redemptions_immutable_delete BEFORE DELETE ON control_command_redemptions BEGIN SELECT RAISE(ABORT,'immutable control command redemption'); END;
CREATE TRIGGER control_effects_immutable_update BEFORE UPDATE ON control_command_effects BEGIN SELECT RAISE(ABORT,'immutable control command effect'); END;
CREATE TRIGGER control_effects_immutable_delete BEFORE DELETE ON control_command_effects BEGIN SELECT RAISE(ABORT,'immutable control command effect'); END;
CREATE TRIGGER control_events_immutable_update BEFORE UPDATE ON control_events BEGIN SELECT RAISE(ABORT,'immutable control event'); END;
CREATE TRIGGER control_events_immutable_delete BEFORE DELETE ON control_events BEGIN SELECT RAISE(ABORT,'immutable control event'); END;
