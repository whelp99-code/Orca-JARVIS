-- Add exact public transition identity without inventing identity for pre-034 rows.
ALTER TABLE personal_recommendation_action_events
  ADD COLUMN transition_occurred_at TEXT
  CHECK(transition_occurred_at IS NULL OR (
    strftime('%Y-%m-%dT%H:%M:%fZ',transition_occurred_at) IS NOT NULL
    AND strftime('%Y-%m-%dT%H:%M:%fZ',transition_occurred_at)=transition_occurred_at
  ));
ALTER TABLE personal_recommendation_action_events
  ADD COLUMN transition_digest TEXT
  CHECK(transition_digest IS NULL OR (
    length(transition_digest)=71 AND substr(transition_digest,1,7)='sha256:'
    AND substr(transition_digest,8) NOT GLOB '*[^0-9a-f]*'
  ));
ALTER TABLE personal_recommendation_action_events
  ADD COLUMN replacement_recommendation_id TEXT REFERENCES personal_recommendations(recommendation_id);

CREATE UNIQUE INDEX personal_action_events_transition_digest
  ON personal_recommendation_action_events(transition_digest) WHERE transition_digest IS NOT NULL;
CREATE INDEX personal_action_events_replacement
  ON personal_recommendation_action_events(replacement_recommendation_id,recommendation_id,rank)
  WHERE replacement_recommendation_id IS NOT NULL;

CREATE TABLE personal_recommendation_transition_migration_evidence (
  migration_id TEXT NOT NULL PRIMARY KEY CHECK(migration_id='034_recommendation_transition_identity.sql'),
  terminal_count INTEGER NOT NULL CHECK(terminal_count>=0),
  superseded_count INTEGER NOT NULL CHECK(superseded_count>=0 AND superseded_count<=terminal_count)
);
INSERT INTO personal_recommendation_transition_migration_evidence(migration_id,terminal_count,superseded_count)
SELECT '034_recommendation_transition_identity.sql',
  COALESCE(SUM(CASE WHEN state<>'pending' THEN 1 ELSE 0 END),0),
  COALESCE(SUM(CASE WHEN state='superseded' THEN 1 ELSE 0 END),0)
FROM personal_recommendation_action_events;

CREATE TRIGGER personal_transition_migration_evidence_immutable_update
BEFORE UPDATE ON personal_recommendation_transition_migration_evidence
BEGIN SELECT RAISE(ABORT,'immutable recommendation transition migration evidence'); END;
CREATE TRIGGER personal_transition_migration_evidence_immutable_delete
BEFORE DELETE ON personal_recommendation_transition_migration_evidence
BEGIN SELECT RAISE(ABORT,'immutable recommendation transition migration evidence'); END;

CREATE TRIGGER personal_action_event_transition_identity
BEFORE INSERT ON personal_recommendation_action_events
WHEN (NEW.state='pending' AND (NEW.transition_occurred_at IS NOT NULL OR NEW.transition_digest IS NOT NULL OR NEW.replacement_recommendation_id IS NOT NULL))
  OR (NEW.state<>'pending' AND (NEW.transition_occurred_at IS NULL OR NEW.transition_digest IS NULL))
  OR ((NEW.state='superseded')<>(NEW.replacement_recommendation_id IS NOT NULL))
  OR (NEW.replacement_recommendation_id IS NOT NULL AND NEW.replacement_recommendation_id=NEW.recommendation_id)
  OR (NEW.state NOT IN ('pending','expired') AND NEW.occurred_at IS NOT NEW.transition_occurred_at)
BEGIN SELECT RAISE(ABORT,'action transition identity invalid'); END;

CREATE TRIGGER personal_action_event_exact_chronology
BEFORE INSERT ON personal_recommendation_action_events
WHEN NEW.state<>'pending' AND EXISTS (
  SELECT 1 FROM personal_recommendation_action_events e
  WHERE e.recommendation_id=NEW.recommendation_id AND e.rank=NEW.rank
    AND COALESCE(e.transition_occurred_at,e.occurred_at)>NEW.transition_occurred_at
)
BEGIN SELECT RAISE(ABORT,'action transition chronology invalid'); END;

CREATE TRIGGER personal_action_event_exact_deadline
BEFORE INSERT ON personal_recommendation_action_events
WHEN NEW.state<>'pending' AND (
  (SELECT min(r.expires_at,json_extract(r.canonical_envelope_json,'$.freshness.fresh_until'),c.expires_at,c.fresh_until)
   FROM personal_recommendations r JOIN personal_context_snapshots c ON c.context_id=r.context_id
   WHERE r.recommendation_id=NEW.recommendation_id) IS NULL
  OR (NEW.state='expired' AND NEW.transition_occurred_at<(
    SELECT min(r.expires_at,json_extract(r.canonical_envelope_json,'$.freshness.fresh_until'),c.expires_at,c.fresh_until)
    FROM personal_recommendations r JOIN personal_context_snapshots c ON c.context_id=r.context_id
    WHERE r.recommendation_id=NEW.recommendation_id
  ))
  OR (NEW.state<>'expired' AND NEW.transition_occurred_at>=(
    SELECT min(r.expires_at,json_extract(r.canonical_envelope_json,'$.freshness.fresh_until'),c.expires_at,c.fresh_until)
    FROM personal_recommendations r JOIN personal_context_snapshots c ON c.context_id=r.context_id
    WHERE r.recommendation_id=NEW.recommendation_id
  ))
)
BEGIN SELECT RAISE(ABORT,'action exact transition deadline invalid'); END;

CREATE TRIGGER personal_action_event_exact_expiry_bridge
BEFORE INSERT ON personal_recommendation_action_events
WHEN NEW.state='expired' AND (
  (SELECT min(r.expires_at,c.expires_at)
   FROM personal_recommendations r JOIN personal_context_snapshots c ON c.context_id=r.context_id
   WHERE r.recommendation_id=NEW.recommendation_id) IS NULL
  OR NEW.occurred_at IS NOT CASE
    WHEN NEW.transition_occurred_at>(
      SELECT min(r.expires_at,c.expires_at)
      FROM personal_recommendations r JOIN personal_context_snapshots c ON c.context_id=r.context_id
      WHERE r.recommendation_id=NEW.recommendation_id
    ) THEN NEW.transition_occurred_at
    ELSE (
      SELECT min(r.expires_at,c.expires_at)
      FROM personal_recommendations r JOIN personal_context_snapshots c ON c.context_id=r.context_id
      WHERE r.recommendation_id=NEW.recommendation_id
    )
  END
)
BEGIN SELECT RAISE(ABORT,'action transition identity invalid'); END;

-- Preserve the 032 terminal-conflict diagnostic while retaining its exact behavior.
DROP TRIGGER personal_action_single_terminal;
CREATE TRIGGER personal_action_single_terminal BEFORE INSERT ON personal_recommendation_action_events
WHEN NEW.state<>'pending' AND EXISTS (
  SELECT 1 FROM personal_recommendation_action_events e
  WHERE e.recommendation_id=NEW.recommendation_id AND e.rank=NEW.rank AND e.state<>'pending'
)
BEGIN SELECT RAISE(ABORT,'action terminal state conflict'); END;
