CREATE TABLE collaboration_identities (
  identity_id TEXT PRIMARY KEY,
  identity_type TEXT NOT NULL CHECK(identity_type IN ('human','agent','system')),
  display_name TEXT NOT NULL,
  provider TEXT,
  public_key_pem TEXT NOT NULL,
  key_fingerprint TEXT NOT NULL UNIQUE,
  owner_identity_id TEXT REFERENCES collaboration_identities(identity_id),
  created_request_id TEXT NOT NULL UNIQUE REFERENCES control_command_requests(request_id),
  created_at TEXT NOT NULL
);

CREATE TABLE collaboration_identity_revocations (
  revocation_id TEXT PRIMARY KEY,
  identity_id TEXT NOT NULL UNIQUE REFERENCES collaboration_identities(identity_id),
  reason TEXT NOT NULL,
  request_id TEXT NOT NULL UNIQUE REFERENCES control_command_requests(request_id),
  revoked_at TEXT NOT NULL
);

CREATE TABLE collaboration_rooms (
  room_id TEXT PRIMARY KEY,
  room_type TEXT NOT NULL CHECK(room_type IN ('general','project','branch','incident','release')),
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  project_id TEXT,
  branch_ref TEXT,
  incident_id TEXT,
  visibility TEXT NOT NULL CHECK(visibility IN ('private','project')),
  created_by_identity_id TEXT NOT NULL REFERENCES collaboration_identities(identity_id),
  created_request_id TEXT NOT NULL UNIQUE REFERENCES control_command_requests(request_id),
  created_at TEXT NOT NULL
);
CREATE INDEX collaboration_rooms_project ON collaboration_rooms(project_id,room_type,created_at,room_id);

CREATE TABLE collaboration_memberships (
  membership_id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL REFERENCES collaboration_rooms(room_id),
  identity_id TEXT NOT NULL REFERENCES collaboration_identities(identity_id),
  role TEXT NOT NULL CHECK(role IN ('owner','maintainer','contributor','reviewer','observer','agent')),
  permissions_json TEXT NOT NULL,
  created_request_id TEXT NOT NULL UNIQUE REFERENCES control_command_requests(request_id),
  joined_at TEXT NOT NULL,
  UNIQUE(room_id,identity_id)
);
CREATE INDEX collaboration_memberships_room ON collaboration_memberships(room_id,role,identity_id);

CREATE TABLE collaboration_membership_revocations (
  revocation_id TEXT PRIMARY KEY,
  membership_id TEXT NOT NULL UNIQUE REFERENCES collaboration_memberships(membership_id),
  reason TEXT NOT NULL,
  request_id TEXT NOT NULL UNIQUE REFERENCES control_command_requests(request_id),
  revoked_at TEXT NOT NULL
);

CREATE TABLE collaboration_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE,
  schema_version INTEGER NOT NULL CHECK(schema_version=1),
  room_id TEXT NOT NULL REFERENCES collaboration_rooms(room_id),
  event_type TEXT NOT NULL CHECK(event_type IN ('message','context','task','evidence','approval_request','approval_decision','workflow','git','system')),
  author_identity_id TEXT NOT NULL REFERENCES collaboration_identities(identity_id),
  thread_root_id TEXT REFERENCES collaboration_events(event_id),
  reply_to_id TEXT REFERENCES collaboration_events(event_id),
  correlation_id TEXT,
  subject_type TEXT,
  subject_id TEXT,
  payload_json TEXT NOT NULL,
  payload_digest TEXT NOT NULL,
  approved_request_id TEXT NOT NULL UNIQUE REFERENCES control_command_requests(request_id),
  author_signature TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX collaboration_events_room_timeline ON collaboration_events(room_id,seq);
CREATE INDEX collaboration_events_correlation ON collaboration_events(correlation_id,seq);
CREATE INDEX collaboration_events_subject ON collaboration_events(subject_type,subject_id,seq);

CREATE TABLE collaboration_bridge_outbox (
  export_id TEXT PRIMARY KEY,
  bridge TEXT NOT NULL CHECK(bridge='buzz'),
  event_id TEXT NOT NULL UNIQUE REFERENCES collaboration_events(event_id),
  envelope_json TEXT NOT NULL,
  envelope_digest TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('pending','delivered','uncertain')),
  created_request_id TEXT NOT NULL UNIQUE REFERENCES control_command_requests(request_id),
  created_at TEXT NOT NULL,
  delivered_at TEXT
);
CREATE INDEX collaboration_bridge_pending ON collaboration_bridge_outbox(state,created_at,export_id);

CREATE TRIGGER collaboration_identities_immutable_update BEFORE UPDATE ON collaboration_identities BEGIN SELECT RAISE(ABORT,'immutable collaboration identity'); END;
CREATE TRIGGER collaboration_identities_immutable_delete BEFORE DELETE ON collaboration_identities BEGIN SELECT RAISE(ABORT,'immutable collaboration identity'); END;
CREATE TRIGGER collaboration_identity_revocations_immutable_update BEFORE UPDATE ON collaboration_identity_revocations BEGIN SELECT RAISE(ABORT,'immutable collaboration identity revocation'); END;
CREATE TRIGGER collaboration_identity_revocations_immutable_delete BEFORE DELETE ON collaboration_identity_revocations BEGIN SELECT RAISE(ABORT,'immutable collaboration identity revocation'); END;
CREATE TRIGGER collaboration_rooms_immutable_update BEFORE UPDATE ON collaboration_rooms BEGIN SELECT RAISE(ABORT,'immutable collaboration room'); END;
CREATE TRIGGER collaboration_rooms_immutable_delete BEFORE DELETE ON collaboration_rooms BEGIN SELECT RAISE(ABORT,'immutable collaboration room'); END;
CREATE TRIGGER collaboration_memberships_immutable_update BEFORE UPDATE ON collaboration_memberships BEGIN SELECT RAISE(ABORT,'immutable collaboration membership'); END;
CREATE TRIGGER collaboration_memberships_immutable_delete BEFORE DELETE ON collaboration_memberships BEGIN SELECT RAISE(ABORT,'immutable collaboration membership'); END;
CREATE TRIGGER collaboration_membership_revocations_immutable_update BEFORE UPDATE ON collaboration_membership_revocations BEGIN SELECT RAISE(ABORT,'immutable collaboration membership revocation'); END;
CREATE TRIGGER collaboration_membership_revocations_immutable_delete BEFORE DELETE ON collaboration_membership_revocations BEGIN SELECT RAISE(ABORT,'immutable collaboration membership revocation'); END;
CREATE TRIGGER collaboration_events_immutable_update BEFORE UPDATE ON collaboration_events BEGIN SELECT RAISE(ABORT,'immutable collaboration event'); END;
CREATE TRIGGER collaboration_events_immutable_delete BEFORE DELETE ON collaboration_events BEGIN SELECT RAISE(ABORT,'immutable collaboration event'); END;
CREATE TRIGGER collaboration_bridge_identity_immutable BEFORE UPDATE OF export_id,bridge,event_id,envelope_json,envelope_digest,created_request_id,created_at ON collaboration_bridge_outbox BEGIN SELECT RAISE(ABORT,'immutable collaboration bridge identity'); END;
CREATE TRIGGER collaboration_bridge_delete BEFORE DELETE ON collaboration_bridge_outbox BEGIN SELECT RAISE(ABORT,'immutable collaboration bridge export'); END;
