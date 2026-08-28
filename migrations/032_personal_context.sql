-- Immutable, bounded advisory context. This schema stores canonical envelopes and digests only;
-- it grants no execution authority and contains no command or executor queue.
CREATE TABLE personal_observations (
  observation_id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  source_id TEXT NOT NULL,
  checkpoint TEXT,
  canonical_digest TEXT NOT NULL,
  content_digest TEXT NOT NULL,
  canonical_envelope_json TEXT NOT NULL CHECK(length(canonical_envelope_json) BETWEEN 2 AND 65536),
  freshness_state TEXT NOT NULL DEFAULT 'fresh' CHECK(freshness_state IN ('fresh','stale','no_data','unavailable','offline')),
  fresh_until TEXT NOT NULL DEFAULT '9999-12-31T23:59:59.999Z' CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',fresh_until)=fresh_until),
  observed_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',observed_at)=observed_at),
  valid_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',valid_at)=valid_at),
  expires_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',expires_at)=expires_at),
  created_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',created_at)=created_at),
  CHECK(length(canonical_digest)=71 AND substr(canonical_digest,1,7)='sha256:' AND substr(canonical_digest,8) NOT GLOB '*[^0-9a-f]*'),
  CHECK(length(content_digest)=71 AND substr(content_digest,1,7)='sha256:' AND substr(content_digest,8) NOT GLOB '*[^0-9a-f]*'),
  CHECK(julianday(observed_at)<=julianday(created_at) AND julianday(valid_at)<=julianday(created_at)),
  CHECK(julianday(created_at)<julianday(expires_at))
);
CREATE UNIQUE INDEX personal_observations_source_checkpoint ON personal_observations(source_id,checkpoint) WHERE checkpoint IS NOT NULL;
CREATE INDEX personal_observations_source_time ON personal_observations(source_id,observed_at,observation_id);
CREATE INDEX personal_observations_expiry ON personal_observations(expires_at,observation_id);
CREATE INDEX personal_observations_content ON personal_observations(content_digest,observation_id);

CREATE TABLE personal_source_checkpoints (
  source_id TEXT NOT NULL,
  sequence INTEGER NOT NULL CHECK(sequence>0),
  checkpoint TEXT NOT NULL,
  observation_id TEXT NOT NULL REFERENCES personal_observations(observation_id),
  observation_digest TEXT NOT NULL,
  observed_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',observed_at)=observed_at),
  recorded_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',recorded_at)=recorded_at),
  PRIMARY KEY(source_id,sequence),
  UNIQUE(source_id,checkpoint),
  UNIQUE(observation_id),
  CHECK(length(observation_digest)=71 AND substr(observation_digest,1,7)='sha256:' AND substr(observation_digest,8) NOT GLOB '*[^0-9a-f]*')
);
CREATE INDEX personal_source_checkpoints_latest ON personal_source_checkpoints(source_id,sequence DESC);

CREATE TABLE personal_context_snapshots (
  context_id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  purpose TEXT NOT NULL CHECK(length(purpose) BETWEEN 1 AND 128),
  declared_query TEXT NOT NULL CHECK(length(CAST(declared_query AS BLOB)) BETWEEN 1 AND 4096),
  version INTEGER NOT NULL CHECK(version>0),
  canonical_digest TEXT NOT NULL UNIQUE,
  persistence_digest TEXT NOT NULL DEFAULT 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
  canonical_envelope_json TEXT NOT NULL CHECK(length(canonical_envelope_json) BETWEEN 2 AND 65536),
  payload_state TEXT NOT NULL DEFAULT 'sufficient' CHECK(payload_state IN ('sufficient','insufficient')),
  freshness_state TEXT NOT NULL DEFAULT 'fresh' CHECK(freshness_state IN ('fresh','stale','no_data','unavailable','offline')),
  fresh_until TEXT NOT NULL DEFAULT '9999-12-31T23:59:59.999Z' CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',fresh_until)=fresh_until),
  item_count INTEGER NOT NULL CHECK(item_count BETWEEN 0 AND 32),
  observation_count INTEGER NOT NULL CHECK(observation_count BETWEEN 0 AND 32 AND observation_count<=item_count),
  evidence_count INTEGER NOT NULL DEFAULT 0 CHECK(evidence_count BETWEEN 0 AND 32),
  memory_count INTEGER NOT NULL DEFAULT 0 CHECK(memory_count BETWEEN 0 AND 32 AND memory_count<=item_count),
  max_items INTEGER NOT NULL CHECK(max_items BETWEEN 1 AND 32),
  max_excerpt_bytes INTEGER NOT NULL CHECK(max_excerpt_bytes BETWEEN 1 AND 4096),
  max_total_bytes INTEGER NOT NULL CHECK(max_total_bytes BETWEEN 1 AND 65536),
  conflict_count INTEGER NOT NULL CHECK(conflict_count BETWEEN 0 AND 32),
  omission_count INTEGER NOT NULL CHECK(omission_count BETWEEN 0 AND 32),
  observed_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',observed_at)=observed_at),
  valid_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',valid_at)=valid_at),
  expires_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',expires_at)=expires_at),
  created_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',created_at)=created_at),
  UNIQUE(purpose,declared_query,version),
  CHECK(item_count<=max_items),
  CHECK(length(canonical_digest)=71 AND substr(canonical_digest,1,7)='sha256:' AND substr(canonical_digest,8) NOT GLOB '*[^0-9a-f]*'),
  CHECK(length(persistence_digest)=71 AND substr(persistence_digest,1,7)='sha256:' AND substr(persistence_digest,8) NOT GLOB '*[^0-9a-f]*'),
  CHECK(julianday(observed_at)<=julianday(created_at) AND julianday(valid_at)<=julianday(created_at)),
  CHECK(julianday(created_at)<julianday(expires_at))
);
CREATE INDEX personal_context_purpose_version ON personal_context_snapshots(purpose,declared_query,version DESC);
CREATE INDEX personal_context_expiry ON personal_context_snapshots(expires_at,context_id);

CREATE TABLE personal_context_observations (
  context_id TEXT NOT NULL REFERENCES personal_context_snapshots(context_id),
  position INTEGER NOT NULL CHECK(position>=0 AND position<32),
  observation_id TEXT NOT NULL REFERENCES personal_observations(observation_id),
  observation_digest TEXT NOT NULL,
  PRIMARY KEY(context_id,position),
  UNIQUE(context_id,observation_id),
  CHECK(length(observation_digest)=71 AND substr(observation_digest,1,7)='sha256:' AND substr(observation_digest,8) NOT GLOB '*[^0-9a-f]*')
);
CREATE INDEX personal_context_observation_ref ON personal_context_observations(observation_id,context_id);

CREATE TABLE personal_context_evidence (
  context_id TEXT NOT NULL REFERENCES personal_context_snapshots(context_id),
  position INTEGER NOT NULL CHECK(position>=0 AND position<32),
  evidence_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  evidence_kind TEXT NOT NULL CHECK(length(evidence_kind) BETWEEN 1 AND 128),
  evidence_digest TEXT NOT NULL,
  freshness_state TEXT NOT NULL DEFAULT 'fresh' CHECK(freshness_state IN ('fresh','stale','no_data','unavailable','offline')),
  fresh_until TEXT NOT NULL DEFAULT '9999-12-31T23:59:59.999Z' CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',fresh_until)=fresh_until),
  observed_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',observed_at)=observed_at),
  PRIMARY KEY(context_id,position),
  UNIQUE(context_id,evidence_id),
  UNIQUE(context_id,evidence_id,source_id,evidence_digest,observed_at,fresh_until),
  CHECK(length(evidence_digest)=71 AND substr(evidence_digest,1,7)='sha256:' AND substr(evidence_digest,8) NOT GLOB '*[^0-9a-f]*')
);
CREATE INDEX personal_context_evidence_ref ON personal_context_evidence(evidence_id,context_id);
CREATE INDEX personal_context_evidence_source ON personal_context_evidence(source_id,context_id,position);
CREATE INDEX personal_context_evidence_freshness ON personal_context_evidence(context_id,fresh_until,position);

CREATE TABLE personal_context_memory_evidence (
  context_id TEXT NOT NULL REFERENCES personal_context_snapshots(context_id),
  memory_ref TEXT NOT NULL,
  evidence_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  evidence_digest TEXT NOT NULL,
  observed_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',observed_at)=observed_at),
  fresh_until TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',fresh_until)=fresh_until),
  PRIMARY KEY(context_id,memory_ref),
  UNIQUE(context_id,evidence_id),
  FOREIGN KEY(context_id,evidence_id) REFERENCES personal_context_evidence(context_id,evidence_id),
  FOREIGN KEY(context_id,evidence_id,source_id,evidence_digest,observed_at,fresh_until)
    REFERENCES personal_context_evidence(context_id,evidence_id,source_id,evidence_digest,observed_at,fresh_until),
  CHECK(length(evidence_digest)=71 AND substr(evidence_digest,1,7)='sha256:' AND substr(evidence_digest,8) NOT GLOB '*[^0-9a-f]*')
);
CREATE INDEX personal_context_memory_evidence_ref ON personal_context_memory_evidence(memory_ref,context_id);

CREATE TABLE personal_recommendations (
  recommendation_id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  context_id TEXT NOT NULL REFERENCES personal_context_snapshots(context_id),
  context_digest TEXT NOT NULL,
  canonical_digest TEXT NOT NULL UNIQUE,
  evidence_digest TEXT NOT NULL,
  persistence_digest TEXT NOT NULL,
  canonical_envelope_json TEXT NOT NULL CHECK(length(canonical_envelope_json) BETWEEN 2 AND 65536),
  approval_requirement TEXT NOT NULL CHECK(approval_requirement IN ('none','owner')),
  confidence_class TEXT NOT NULL CHECK(confidence_class IN ('low','medium','high')),
  lifecycle_state TEXT NOT NULL CHECK(lifecycle_state IN ('drafted','parsed','eligible','abstained','presented','selected','rejected','expired')),
  observed_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',observed_at)=observed_at),
  valid_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',valid_at)=valid_at),
  expires_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',expires_at)=expires_at),
  created_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',created_at)=created_at),
  CHECK(length(context_digest)=71 AND substr(context_digest,1,7)='sha256:' AND substr(context_digest,8) NOT GLOB '*[^0-9a-f]*'),
  CHECK(length(canonical_digest)=71 AND substr(canonical_digest,1,7)='sha256:' AND substr(canonical_digest,8) NOT GLOB '*[^0-9a-f]*'),
  CHECK(length(evidence_digest)=71 AND substr(evidence_digest,1,7)='sha256:' AND substr(evidence_digest,8) NOT GLOB '*[^0-9a-f]*'),
  CHECK(length(persistence_digest)=71 AND substr(persistence_digest,1,7)='sha256:' AND substr(persistence_digest,8) NOT GLOB '*[^0-9a-f]*'),
  CHECK(julianday(observed_at)<=julianday(created_at) AND julianday(valid_at)<=julianday(created_at)),
  CHECK(julianday(created_at)<julianday(expires_at))
);
CREATE INDEX personal_recommendations_context ON personal_recommendations(context_id,created_at,recommendation_id);
CREATE INDEX personal_recommendations_lifecycle ON personal_recommendations(lifecycle_state,expires_at,recommendation_id);
CREATE INDEX personal_recommendations_expiry ON personal_recommendations(expires_at,recommendation_id);

CREATE TABLE personal_recommendation_evidence (
  recommendation_id TEXT NOT NULL REFERENCES personal_recommendations(recommendation_id),
  position INTEGER NOT NULL CHECK(position>=0 AND position<32),
  evidence_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  evidence_digest TEXT NOT NULL,
  observed_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',observed_at)=observed_at),
  PRIMARY KEY(recommendation_id,position),
  UNIQUE(recommendation_id,evidence_id),
  CHECK(length(evidence_digest)=71 AND substr(evidence_digest,1,7)='sha256:' AND substr(evidence_digest,8) NOT GLOB '*[^0-9a-f]*')
);
CREATE INDEX personal_recommendation_evidence_ref ON personal_recommendation_evidence(evidence_id,recommendation_id);

CREATE TABLE personal_recommendation_actions (
  recommendation_id TEXT NOT NULL REFERENCES personal_recommendations(recommendation_id),
  rank INTEGER NOT NULL CHECK(rank BETWEEN 1 AND 32),
  title TEXT NOT NULL CHECK(length(CAST(title AS BLOB)) BETWEEN 1 AND 512),
  operation TEXT NOT NULL CHECK(length(operation) BETWEEN 1 AND 128),
  target_digest TEXT NOT NULL,
  initial_state TEXT NOT NULL CHECK(initial_state='pending'),
  PRIMARY KEY(recommendation_id,rank),
  CHECK(length(target_digest)=71 AND substr(target_digest,1,7)='sha256:' AND substr(target_digest,8) NOT GLOB '*[^0-9a-f]*')
);
CREATE INDEX personal_recommendation_actions_target ON personal_recommendation_actions(target_digest,recommendation_id,rank);

CREATE TABLE personal_recommendation_action_events (
  event_sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  recommendation_id TEXT NOT NULL,
  rank INTEGER NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('pending','accepted','rejected','expired','superseded','dismissed','snoozed')),
  evidence_digest TEXT NOT NULL,
  occurred_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',occurred_at)=occurred_at),
  FOREIGN KEY(recommendation_id,rank) REFERENCES personal_recommendation_actions(recommendation_id,rank),
  UNIQUE(recommendation_id,rank,state),
  CHECK(length(evidence_digest)=71 AND substr(evidence_digest,1,7)='sha256:' AND substr(evidence_digest,8) NOT GLOB '*[^0-9a-f]*')
);
CREATE INDEX personal_action_events_history ON personal_recommendation_action_events(recommendation_id,rank,event_sequence);

CREATE TABLE personal_context_audit_events (
  event_sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type TEXT NOT NULL CHECK(event_type IN ('observation_recorded','checkpoint_advanced','context_recorded','recommendation_recorded','action_state_recorded')),
  subject_id TEXT NOT NULL,
  subject_digest TEXT NOT NULL,
  correlation_id TEXT NOT NULL,
  causation_id TEXT,
  occurred_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',occurred_at)=occurred_at),
  UNIQUE(event_type,subject_id,subject_digest),
  CHECK(length(subject_digest)=71 AND substr(subject_digest,1,7)='sha256:' AND substr(subject_digest,8) NOT GLOB '*[^0-9a-f]*')
);
CREATE INDEX personal_context_audit_subject ON personal_context_audit_events(subject_id,event_sequence);
CREATE INDEX personal_context_audit_correlation ON personal_context_audit_events(correlation_id,event_sequence);

CREATE TRIGGER personal_observations_immutable_update BEFORE UPDATE ON personal_observations BEGIN SELECT RAISE(ABORT,'immutable personal observation'); END;
CREATE TRIGGER personal_observations_immutable_delete BEFORE DELETE ON personal_observations BEGIN SELECT RAISE(ABORT,'immutable personal observation'); END;
CREATE TRIGGER personal_source_checkpoints_immutable_update BEFORE UPDATE ON personal_source_checkpoints BEGIN SELECT RAISE(ABORT,'immutable source checkpoint'); END;
CREATE TRIGGER personal_source_checkpoints_immutable_delete BEFORE DELETE ON personal_source_checkpoints BEGIN SELECT RAISE(ABORT,'immutable source checkpoint'); END;
CREATE TRIGGER personal_context_snapshots_immutable_update BEFORE UPDATE ON personal_context_snapshots BEGIN SELECT RAISE(ABORT,'immutable context snapshot'); END;
CREATE TRIGGER personal_context_snapshots_immutable_delete BEFORE DELETE ON personal_context_snapshots BEGIN SELECT RAISE(ABORT,'immutable context snapshot'); END;
CREATE TRIGGER personal_context_observations_immutable_update BEFORE UPDATE ON personal_context_observations BEGIN SELECT RAISE(ABORT,'immutable context evidence link'); END;
CREATE TRIGGER personal_context_observations_immutable_delete BEFORE DELETE ON personal_context_observations BEGIN SELECT RAISE(ABORT,'immutable context evidence link'); END;
CREATE TRIGGER personal_context_evidence_immutable_update BEFORE UPDATE ON personal_context_evidence BEGIN SELECT RAISE(ABORT,'immutable generic context evidence'); END;
CREATE TRIGGER personal_context_evidence_immutable_delete BEFORE DELETE ON personal_context_evidence BEGIN SELECT RAISE(ABORT,'immutable generic context evidence'); END;
CREATE TRIGGER personal_context_memory_evidence_immutable_update BEFORE UPDATE ON personal_context_memory_evidence BEGIN SELECT RAISE(ABORT,'immutable context memory evidence'); END;
CREATE TRIGGER personal_context_memory_evidence_immutable_delete BEFORE DELETE ON personal_context_memory_evidence BEGIN SELECT RAISE(ABORT,'immutable context memory evidence'); END;
CREATE TRIGGER personal_recommendation_context_expiry BEFORE INSERT ON personal_recommendations WHEN julianday(NEW.expires_at)>julianday((SELECT expires_at FROM personal_context_snapshots WHERE context_id=NEW.context_id)) BEGIN SELECT RAISE(ABORT,'recommendation outlives context'); END;
CREATE TRIGGER personal_recommendations_immutable_update BEFORE UPDATE ON personal_recommendations BEGIN SELECT RAISE(ABORT,'immutable recommendation'); END;
CREATE TRIGGER personal_recommendations_immutable_delete BEFORE DELETE ON personal_recommendations BEGIN SELECT RAISE(ABORT,'immutable recommendation'); END;
CREATE TRIGGER personal_recommendation_evidence_immutable_update BEFORE UPDATE ON personal_recommendation_evidence BEGIN SELECT RAISE(ABORT,'immutable recommendation evidence'); END;
CREATE TRIGGER personal_recommendation_evidence_immutable_delete BEFORE DELETE ON personal_recommendation_evidence BEGIN SELECT RAISE(ABORT,'immutable recommendation evidence'); END;
CREATE TRIGGER personal_recommendation_actions_immutable_update BEFORE UPDATE ON personal_recommendation_actions BEGIN SELECT RAISE(ABORT,'immutable recommendation action'); END;
CREATE TRIGGER personal_recommendation_actions_immutable_delete BEFORE DELETE ON personal_recommendation_actions BEGIN SELECT RAISE(ABORT,'immutable recommendation action'); END;
CREATE TRIGGER personal_action_event_chronology BEFORE INSERT ON personal_recommendation_action_events WHEN EXISTS (SELECT 1 FROM personal_recommendation_action_events e WHERE e.recommendation_id=NEW.recommendation_id AND e.rank=NEW.rank AND julianday(e.occurred_at)>julianday(NEW.occurred_at)) BEGIN SELECT RAISE(ABORT,'action event chronology invalid'); END;
CREATE TRIGGER personal_action_single_terminal BEFORE INSERT ON personal_recommendation_action_events WHEN NEW.state<>'pending' AND EXISTS (SELECT 1 FROM personal_recommendation_action_events e WHERE e.recommendation_id=NEW.recommendation_id AND e.rank=NEW.rank AND e.state<>'pending') BEGIN SELECT RAISE(ABORT,'action terminal state conflict'); END;
CREATE TRIGGER personal_action_event_deadline BEFORE INSERT ON personal_recommendation_action_events WHEN (NEW.state='expired' AND julianday(NEW.occurred_at)<julianday((SELECT min(r.expires_at,c.expires_at) FROM personal_recommendations r JOIN personal_context_snapshots c ON c.context_id=r.context_id WHERE r.recommendation_id=NEW.recommendation_id))) OR (NEW.state NOT IN ('pending','expired') AND julianday(NEW.occurred_at)>=julianday((SELECT min(r.expires_at,c.expires_at) FROM personal_recommendations r JOIN personal_context_snapshots c ON c.context_id=r.context_id WHERE r.recommendation_id=NEW.recommendation_id))) BEGIN SELECT RAISE(ABORT,'action event deadline invalid'); END;
CREATE TRIGGER personal_recommendation_action_events_immutable_update BEFORE UPDATE ON personal_recommendation_action_events BEGIN SELECT RAISE(ABORT,'immutable recommendation action event'); END;
CREATE TRIGGER personal_recommendation_action_events_immutable_delete BEFORE DELETE ON personal_recommendation_action_events BEGIN SELECT RAISE(ABORT,'immutable recommendation action event'); END;
CREATE TRIGGER personal_context_audit_events_immutable_update BEFORE UPDATE ON personal_context_audit_events BEGIN SELECT RAISE(ABORT,'immutable personal context audit'); END;
CREATE TRIGGER personal_context_audit_events_immutable_delete BEFORE DELETE ON personal_context_audit_events BEGIN SELECT RAISE(ABORT,'immutable personal context audit'); END;
