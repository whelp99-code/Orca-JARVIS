-- allow: SIZE_OK - indivisible forward hardening of one three-table lifecycle.
ALTER TABLE daily_loop_runs ADD COLUMN record_version INTEGER NOT NULL DEFAULT 0 CHECK(record_version IN (0,1));
ALTER TABLE daily_loop_runs ADD COLUMN phase TEXT CHECK(phase IS NULL OR phase IN ('morning','in_day','evening'));
ALTER TABLE daily_loop_runs ADD COLUMN not_before TEXT CHECK(not_before IS NULL OR (length(not_before)=24 AND strftime('%Y-%m-%dT%H:%M:%fZ',not_before)=not_before));
ALTER TABLE daily_loop_runs ADD COLUMN input_json TEXT CHECK(input_json IS NULL OR json_valid(input_json));
ALTER TABLE daily_loop_runs ADD COLUMN input_digest TEXT CHECK(input_digest IS NULL OR (length(input_digest)=71 AND substr(input_digest,1,7)='sha256:' AND substr(input_digest,8) NOT GLOB '*[^0-9a-f]*'));
ALTER TABLE daily_loop_steps ADD COLUMN record_version INTEGER NOT NULL DEFAULT 0 CHECK(record_version IN (0,1));
ALTER TABLE daily_loop_steps ADD COLUMN transition_fence INTEGER NOT NULL DEFAULT 0 CHECK(transition_fence>=0);
ALTER TABLE daily_loop_steps ADD COLUMN detail_json TEXT CHECK(detail_json IS NULL OR json_valid(detail_json));
ALTER TABLE daily_loop_checkpoints ADD COLUMN record_version INTEGER NOT NULL DEFAULT 0 CHECK(record_version IN (0,1));
ALTER TABLE daily_loop_checkpoints ADD COLUMN detail_json TEXT CHECK(detail_json IS NULL OR json_valid(detail_json));
CREATE INDEX daily_loop_runs_due ON daily_loop_runs(state,not_before,expires_at,run_id) WHERE record_version=1 AND state='pending';

CREATE TABLE daily_loop_migration_035_evidence (
  migration_id TEXT PRIMARY KEY CHECK(migration_id='035_daily_loop_durable_guards.sql'),
  legacy_run_count INTEGER NOT NULL CHECK(legacy_run_count>=0),
  legacy_step_count INTEGER NOT NULL CHECK(legacy_step_count>=0),
  legacy_checkpoint_count INTEGER NOT NULL CHECK(legacy_checkpoint_count>=0),
  invalid_checkpoint_count INTEGER NOT NULL CHECK(invalid_checkpoint_count=0)
);
INSERT INTO daily_loop_migration_035_evidence
  (migration_id,legacy_run_count,legacy_step_count,legacy_checkpoint_count,invalid_checkpoint_count)
SELECT '035_daily_loop_durable_guards.sql',
  (SELECT count(*) FROM daily_loop_runs WHERE record_version=0),
  (SELECT count(*) FROM daily_loop_steps WHERE record_version=0),
  (SELECT count(*) FROM daily_loop_checkpoints WHERE record_version=0),
  (SELECT count(*) FROM daily_loop_checkpoints c
   WHERE NOT EXISTS (SELECT 1 FROM daily_loop_runs r WHERE r.run_id=c.run_id AND c.lease_fence<=r.lease_fence AND c.created_at<c.lease_expires_at AND c.lease_expires_at<=r.expires_at)
      OR (c.step_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM daily_loop_steps s WHERE s.step_id=c.step_id AND s.run_id=c.run_id))
      OR (c.sequence=1 AND c.previous_digest IS NOT NULL)
      OR (c.sequence>1 AND NOT EXISTS (SELECT 1 FROM daily_loop_checkpoints p WHERE p.run_id=c.run_id AND p.sequence=c.sequence-1 AND p.checkpoint_digest=c.previous_digest)));
CREATE TRIGGER daily_loop_migration_035_evidence_immutable_update BEFORE UPDATE ON daily_loop_migration_035_evidence BEGIN SELECT RAISE(ABORT,'immutable daily loop migration evidence'); END;
CREATE TRIGGER daily_loop_migration_035_evidence_immutable_delete BEFORE DELETE ON daily_loop_migration_035_evidence BEGIN SELECT RAISE(ABORT,'immutable daily loop migration evidence'); END;

DROP TRIGGER daily_loop_runs_claim_guard;
DROP TRIGGER daily_loop_runs_reclaim_guard;
DROP TRIGGER daily_loop_runs_active_lease;
DROP TRIGGER daily_loop_runs_lease_expiry_guard;

CREATE TRIGGER daily_loop_runs_v1_insert BEFORE INSERT ON daily_loop_runs
WHEN NEW.record_version<>1 OR NEW.state<>'pending' OR NEW.lease_fence<>0 OR NEW.lease_owner IS NOT NULL OR NEW.lease_expires_at IS NOT NULL
 OR NEW.phase IS NULL OR NEW.not_before IS NULL OR NEW.input_json IS NULL OR NEW.input_digest IS NULL
 OR NEW.created_at>NEW.not_before OR NEW.not_before>=NEW.expires_at
 OR json_type(NEW.input_json)<>'object' OR (SELECT count(*) FROM json_each(NEW.input_json))<>13
 OR EXISTS (SELECT 1 FROM json_each(NEW.input_json) WHERE key NOT IN ('logical_key','local_date','phase','scheduled_at','occurred_at','event_id','critical','critical_reason','event_cost','not_before','created_at','deadline_at','steps'))
 OR json_extract(NEW.input_json,'$.logical_key')<>NEW.idempotency_key OR json_extract(NEW.input_json,'$.local_date')<>NEW.loop_date
 OR json_extract(NEW.input_json,'$.phase')<>NEW.phase OR json_extract(NEW.input_json,'$.not_before')<>NEW.not_before
 OR json_extract(NEW.input_json,'$.created_at')<>NEW.created_at OR json_extract(NEW.input_json,'$.deadline_at')<>NEW.expires_at
 OR json_type(NEW.input_json,'$.steps')<>'array'
 OR EXISTS (SELECT 1 FROM json_each(NEW.input_json,'$.steps') x WHERE json_type(x.value)<>'object' OR (SELECT count(*) FROM json_each(x.value))<>2 OR EXISTS (SELECT 1 FROM json_each(x.value) y WHERE y.key NOT IN ('key','sequence')) OR json_type(x.value,'$.key')<>'text' OR length(json_extract(x.value,'$.key'))=0 OR json_type(x.value,'$.sequence')<>'integer' OR json_extract(x.value,'$.sequence')<>CAST(x.key AS INTEGER)+1)
 OR length(NEW.input_digest)<>71 OR substr(NEW.input_digest,1,7)<>'sha256:' OR substr(NEW.input_digest,8) GLOB '*[^0-9a-f]*'
 OR (NEW.phase IN ('morning','evening') AND (json_type(NEW.input_json,'$.scheduled_at')<>'text' OR json_type(NEW.input_json,'$.occurred_at')<>'null' OR json_type(NEW.input_json,'$.event_id')<>'null' OR json_type(NEW.input_json,'$.critical_reason')<>'null' OR json_type(NEW.input_json,'$.event_cost')<>'null' OR json_extract(NEW.input_json,'$.critical')<>0))
 OR (NEW.phase='in_day' AND (json_type(NEW.input_json,'$.occurred_at')<>'text' OR json_type(NEW.input_json,'$.event_id')<>'text' OR json_type(NEW.input_json,'$.critical') NOT IN ('true','false') OR json_type(NEW.input_json,'$.event_cost')<>'object' OR (SELECT count(*) FROM json_each(NEW.input_json,'$.event_cost'))<>3 OR EXISTS (SELECT 1 FROM json_each(NEW.input_json,'$.event_cost') WHERE key NOT IN ('items','work','bytes') OR type<>'integer' OR value<0 OR value>2147483647) OR (json_extract(NEW.input_json,'$.critical')=1 AND json_type(NEW.input_json,'$.critical_reason')<>'text') OR (json_extract(NEW.input_json,'$.critical')=0 AND json_type(NEW.input_json,'$.critical_reason')<>'null')))
BEGIN SELECT RAISE(ABORT,'daily loop v1 input invalid'); END;
CREATE TRIGGER daily_loop_runs_v1_identity_immutable BEFORE UPDATE OF record_version,phase,not_before,input_json,input_digest ON daily_loop_runs BEGIN SELECT RAISE(ABORT,'immutable daily loop v1 input'); END;
CREATE TRIGGER daily_loop_runs_monotonic_time BEFORE UPDATE ON daily_loop_runs WHEN NEW.updated_at<OLD.updated_at BEGIN SELECT RAISE(ABORT,'daily loop time regression'); END;
CREATE TRIGGER daily_loop_runs_claim_ready BEFORE UPDATE OF state ON daily_loop_runs
WHEN OLD.state='pending' AND NEW.state='claimed' AND (NEW.not_before>NEW.updated_at OR NEW.updated_at>=NEW.expires_at
 OR (SELECT count(*) FROM daily_loop_steps WHERE run_id=NEW.run_id)<>json_array_length(NEW.input_json,'$.steps')
 OR EXISTS (SELECT 1 FROM daily_loop_steps s WHERE s.run_id=NEW.run_id AND (s.sequence<>CAST(json_extract(NEW.input_json,'$.steps['||(s.sequence-1)||'].sequence') AS INTEGER) OR s.step_key<>json_extract(NEW.input_json,'$.steps['||(s.sequence-1)||'].key'))))
BEGIN SELECT RAISE(ABORT,'daily loop preparation incomplete'); END;

CREATE TRIGGER daily_loop_runs_lease_mutation BEFORE UPDATE OF lease_owner,lease_fence,lease_expires_at ON daily_loop_runs
WHEN NOT (
 (NEW.lease_owner IS OLD.lease_owner AND NEW.lease_fence=OLD.lease_fence AND NEW.lease_expires_at IS OLD.lease_expires_at)
 OR (OLD.state='pending' AND OLD.lease_fence=0 AND OLD.lease_owner IS NULL AND OLD.lease_expires_at IS NULL AND NEW.state='claimed' AND NEW.lease_fence=1 AND length(trim(NEW.lease_owner))>0 AND (NEW.record_version=0 OR NEW.not_before<=NEW.updated_at) AND NEW.updated_at<NEW.lease_expires_at AND NEW.lease_expires_at<=NEW.expires_at)
 OR (OLD.state IN ('claimed','running','verifying') AND OLD.lease_fence>0 AND OLD.lease_owner IS NOT NULL AND OLD.lease_expires_at<=NEW.updated_at AND NEW.updated_at<OLD.expires_at AND NEW.state=OLD.state AND OLD.lease_fence<9223372036854775807 AND NEW.lease_fence=OLD.lease_fence+1 AND length(trim(NEW.lease_owner))>0 AND NEW.updated_at<NEW.lease_expires_at AND NEW.lease_expires_at<=OLD.expires_at)
 OR (OLD.state IN ('claimed','running','verifying') AND NEW.state IN ('completed','failed','uncertain') AND NEW.lease_fence=OLD.lease_fence AND NEW.lease_owner IS NULL AND NEW.lease_expires_at IS NULL)
)
BEGIN SELECT RAISE(ABORT,'daily loop lease mutation invalid'); END;

CREATE TRIGGER daily_loop_runs_exact_current_lease BEFORE UPDATE OF state ON daily_loop_runs
WHEN OLD.state<>NEW.state AND NEW.state IN ('running','verifying','completed') AND NOT (OLD.lease_owner IS NOT NULL AND OLD.lease_fence>0 AND NEW.lease_fence=OLD.lease_fence AND NEW.updated_at<OLD.lease_expires_at AND NEW.updated_at<OLD.expires_at)
BEGIN SELECT RAISE(ABORT,'daily loop current lease required'); END;

CREATE TRIGGER daily_loop_runs_transition_checkpoint BEFORE UPDATE OF state ON daily_loop_runs
WHEN OLD.state<>NEW.state AND NOT (OLD.state='pending' AND NEW.state='claimed') AND NOT (OLD.state='pending' AND NEW.state='failed' AND NEW.failure_code='MISSED_RECOVERY_WINDOW' AND NEW.lease_fence=0 AND NEW.lease_owner IS NULL)
 AND NOT EXISTS (SELECT 1 FROM daily_loop_checkpoints c WHERE c.run_id=NEW.run_id AND c.step_id IS NULL AND c.state=NEW.state AND c.lease_fence=NEW.lease_fence AND c.created_at=NEW.updated_at AND c.sequence=(SELECT max(sequence) FROM daily_loop_checkpoints WHERE run_id=NEW.run_id))
BEGIN SELECT RAISE(ABORT,'daily loop run checkpoint required'); END;

CREATE TRIGGER daily_loop_steps_v1_insert BEFORE INSERT ON daily_loop_steps
WHEN NEW.record_version<>1 OR NEW.state<>'pending' OR NEW.transition_fence<>0 OR NEW.detail_json IS NOT NULL OR NEW.evidence_digest IS NOT NULL OR NEW.result_digest IS NOT NULL
 OR NOT EXISTS (SELECT 1 FROM daily_loop_runs r WHERE r.run_id=NEW.run_id AND r.record_version=1 AND json_extract(r.input_json,'$.steps['||(NEW.sequence-1)||'].sequence')=NEW.sequence AND json_extract(r.input_json,'$.steps['||(NEW.sequence-1)||'].key')=NEW.step_key)
BEGIN SELECT RAISE(ABORT,'daily loop v1 step invalid'); END;
CREATE TRIGGER daily_loop_steps_identity_immutable BEFORE UPDATE OF record_version,step_id,run_id,sequence,step_key,created_at ON daily_loop_steps BEGIN SELECT RAISE(ABORT,'immutable daily loop step identity'); END;
CREATE TRIGGER daily_loop_steps_terminal_immutable BEFORE UPDATE ON daily_loop_steps WHEN OLD.state IN ('completed','failed','uncertain') BEGIN SELECT RAISE(ABORT,'immutable terminal daily loop step'); END;
CREATE TRIGGER daily_loop_steps_transition_fence BEFORE UPDATE ON daily_loop_steps
WHEN (OLD.state<>NEW.state OR OLD.transition_fence<>NEW.transition_fence) AND NOT (
 (OLD.state='pending' AND NEW.state='claimed' AND NEW.transition_fence=(SELECT lease_fence FROM daily_loop_runs WHERE run_id=NEW.run_id) AND EXISTS (SELECT 1 FROM daily_loop_runs r WHERE r.run_id=NEW.run_id AND r.state IN ('claimed','running') AND r.lease_owner IS NOT NULL AND NEW.updated_at<r.lease_expires_at AND NEW.updated_at<r.expires_at) AND NOT EXISTS (SELECT 1 FROM daily_loop_steps s WHERE s.run_id=NEW.run_id AND s.sequence<NEW.sequence AND s.state<>'completed') AND NOT EXISTS (SELECT 1 FROM daily_loop_steps s WHERE s.run_id=NEW.run_id AND s.sequence>NEW.sequence AND s.state<>'pending'))
 OR (OLD.state||':'||NEW.state IN ('claimed:running','running:verifying','verifying:completed','verifying:failed','verifying:uncertain') AND NEW.transition_fence=OLD.transition_fence AND NEW.transition_fence=(SELECT lease_fence FROM daily_loop_runs WHERE run_id=NEW.run_id) AND EXISTS (SELECT 1 FROM daily_loop_runs r WHERE r.run_id=NEW.run_id AND NEW.updated_at<r.lease_expires_at AND NEW.updated_at<r.expires_at))
 OR (OLD.state=NEW.state AND OLD.state IN ('claimed','running','verifying') AND ((OLD.record_version=0 AND OLD.transition_fence=0) OR OLD.transition_fence>0) AND NEW.transition_fence=(SELECT lease_fence FROM daily_loop_runs WHERE run_id=NEW.run_id) AND NEW.transition_fence>OLD.transition_fence AND NEW.detail_json IS OLD.detail_json AND NEW.evidence_digest IS OLD.evidence_digest AND NEW.result_digest IS OLD.result_digest)
)
BEGIN SELECT RAISE(ABORT,'daily loop stale step fence'); END;
CREATE TRIGGER daily_loop_steps_checkpoint_required BEFORE UPDATE OF state ON daily_loop_steps
WHEN OLD.state<>NEW.state AND NOT (OLD.state='pending' AND NEW.state='claimed') AND NOT EXISTS (SELECT 1 FROM daily_loop_checkpoints c WHERE c.run_id=NEW.run_id AND c.step_id=NEW.step_id AND c.state=NEW.state AND c.lease_fence=NEW.transition_fence AND c.created_at=NEW.updated_at AND c.sequence=(SELECT max(sequence) FROM daily_loop_checkpoints WHERE run_id=NEW.run_id))
BEGIN SELECT RAISE(ABORT,'daily loop step checkpoint required'); END;
CREATE TRIGGER daily_loop_steps_digest_material BEFORE UPDATE ON daily_loop_steps
WHEN (OLD.state='pending' AND NEW.state='claimed' AND (NEW.detail_json IS NULL OR json_valid(NEW.detail_json)=0 OR NEW.evidence_digest IS NULL OR length(NEW.evidence_digest)<>71 OR NEW.result_digest IS NOT NULL))
 OR (OLD.state<>'pending' AND (NEW.detail_json IS NOT OLD.detail_json OR NEW.evidence_digest IS NOT OLD.evidence_digest))
 OR (NEW.result_digest IS NOT OLD.result_digest AND NOT (OLD.state='verifying' AND NEW.state='completed' AND NEW.result_digest IS NOT NULL))
 OR (OLD.state=NEW.state AND (NEW.detail_json IS NOT OLD.detail_json OR NEW.evidence_digest IS NOT OLD.evidence_digest OR NEW.result_digest IS NOT OLD.result_digest))
BEGIN SELECT RAISE(ABORT,'immutable daily loop step evidence'); END;

CREATE TRIGGER daily_loop_checkpoints_v1_required BEFORE INSERT ON daily_loop_checkpoints
WHEN NEW.record_version<>1 OR NEW.detail_json IS NULL OR json_valid(NEW.detail_json)=0 OR NEW.state IN ('pending','claimed') OR length(NEW.checkpoint_digest)<>71 OR substr(NEW.checkpoint_digest,1,7)<>'sha256:' OR substr(NEW.checkpoint_digest,8) GLOB '*[^0-9a-f]*'
BEGIN SELECT RAISE(ABORT,'daily loop checkpoint v1 required'); END;
CREATE TRIGGER daily_loop_checkpoints_step_binding BEFORE INSERT ON daily_loop_checkpoints WHEN NEW.step_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM daily_loop_steps WHERE step_id=NEW.step_id AND run_id=NEW.run_id) BEGIN SELECT RAISE(ABORT,'daily loop checkpoint step mismatch'); END;
CREATE TRIGGER daily_loop_checkpoints_chain BEFORE INSERT ON daily_loop_checkpoints
WHEN NEW.sequence<>(SELECT count(*)+1 FROM daily_loop_checkpoints WHERE run_id=NEW.run_id) OR (NEW.sequence=1 AND NEW.previous_digest IS NOT NULL) OR (NEW.sequence>1 AND NOT EXISTS (SELECT 1 FROM daily_loop_checkpoints WHERE run_id=NEW.run_id AND sequence=NEW.sequence-1 AND checkpoint_digest=NEW.previous_digest))
BEGIN SELECT RAISE(ABORT,'daily loop checkpoint chain invalid'); END;
CREATE TRIGGER daily_loop_checkpoints_current_fence BEFORE INSERT ON daily_loop_checkpoints
WHEN NOT EXISTS (SELECT 1 FROM daily_loop_runs r WHERE r.run_id=NEW.run_id AND r.lease_owner IS NOT NULL AND r.lease_fence=NEW.lease_fence AND r.lease_expires_at=NEW.lease_expires_at AND ((NEW.state IN ('running','verifying','completed') AND NEW.created_at<r.lease_expires_at AND NEW.created_at<r.expires_at) OR (NEW.state IN ('failed','uncertain') AND NEW.created_at<=r.lease_expires_at AND NEW.created_at<=r.expires_at)))
BEGIN SELECT RAISE(ABORT,'daily loop stale checkpoint fence'); END;
CREATE TRIGGER daily_loop_checkpoints_transition BEFORE INSERT ON daily_loop_checkpoints
WHEN (NEW.step_id IS NULL AND NOT EXISTS (SELECT 1 FROM daily_loop_runs r WHERE r.run_id=NEW.run_id AND r.state||':'||NEW.state IN ('claimed:running','claimed:failed','claimed:uncertain','running:verifying','running:failed','running:uncertain','verifying:completed','verifying:failed','verifying:uncertain') AND (NEW.state<>'verifying' OR NOT EXISTS (SELECT 1 FROM daily_loop_steps s WHERE s.run_id=NEW.run_id AND s.state<>'completed')) AND (NEW.state<>'completed' OR EXISTS (SELECT 1 FROM daily_loop_checkpoints p WHERE p.run_id=NEW.run_id AND p.step_id IS NULL AND p.state='verifying' AND p.sequence=NEW.sequence-1))))
 OR (NEW.step_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM daily_loop_steps s WHERE s.step_id=NEW.step_id AND s.run_id=NEW.run_id AND s.state||':'||NEW.state IN ('claimed:running','running:verifying','verifying:completed','verifying:failed','verifying:uncertain') AND (NEW.state<>'running' OR NOT EXISTS (SELECT 1 FROM daily_loop_steps p WHERE p.run_id=NEW.run_id AND p.sequence<s.sequence AND p.state<>'completed'))))
BEGIN SELECT RAISE(ABORT,'daily loop checkpoint transition invalid'); END;

DROP TRIGGER daily_loop_runs_exact_current_lease;
CREATE TRIGGER daily_loop_runs_exact_current_lease BEFORE UPDATE OF state ON daily_loop_runs
WHEN OLD.state<>NEW.state AND NEW.state IN ('running','verifying','completed') AND NOT (OLD.lease_owner IS NOT NULL AND OLD.lease_fence>0 AND NEW.lease_fence=OLD.lease_fence AND NEW.updated_at<OLD.lease_expires_at AND NEW.updated_at<OLD.expires_at)
BEGIN SELECT RAISE(ABORT,'daily loop current lease required'); END;
