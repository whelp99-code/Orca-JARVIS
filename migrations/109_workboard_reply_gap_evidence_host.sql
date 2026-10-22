-- Remap only reply-gap URL origins; suffix bytes and unrelated sources are untouched.
-- Rollback: UPDATE workboard_works SET evidence_ref = (
--   SELECT prior_evidence_ref FROM workboard_evidence_ref_host_remap_20261016 r
--   WHERE r.work_id = workboard_works.work_id
-- ) WHERE work_id IN (SELECT work_id FROM workboard_evidence_ref_host_remap_20261016);

CREATE TABLE workboard_evidence_ref_host_remap_20261016 (
  work_id TEXT PRIMARY KEY,
  prior_evidence_ref TEXT NOT NULL
);

WITH origins(origin) AS (VALUES
  ('http://100.87.81.57:3010'), ('https://100.87.81.57:3010'),
  ('http://100.87.81.57:8451'), ('https://100.87.81.57:8451'),
  ('http://jm-acloud.alpines-goldeye.ts.net:3010'), ('https://jm-acloud.alpines-goldeye.ts.net:3010'),
  ('http://jm-acloud.alpines-goldeye.ts.net:8451'), ('https://jm-acloud.alpines-goldeye.ts.net:8451')
)
INSERT INTO workboard_evidence_ref_host_remap_20261016(work_id, prior_evidence_ref)
SELECT w.work_id, w.evidence_ref FROM workboard_works w JOIN origins o
  ON substr(w.evidence_ref,1,length(o.origin))=o.origin
  AND substr(w.evidence_ref,length(o.origin)+1,1) IN ('','/','?','#')
WHERE w.source_key='linux:mail:reply-gap:v1';

WITH origins(origin) AS (VALUES
  ('http://100.87.81.57:3010'), ('https://100.87.81.57:3010'),
  ('http://100.87.81.57:8451'), ('https://100.87.81.57:8451'),
  ('http://jm-acloud.alpines-goldeye.ts.net:3010'), ('https://jm-acloud.alpines-goldeye.ts.net:3010'),
  ('http://jm-acloud.alpines-goldeye.ts.net:8451'), ('https://jm-acloud.alpines-goldeye.ts.net:8451')
)
UPDATE workboard_works AS w SET evidence_ref=(
  SELECT 'https://jm-omachy.alpines-goldeye.ts.net:8451' || substr(w.evidence_ref,length(o.origin)+1)
  FROM origins o WHERE substr(w.evidence_ref,1,length(o.origin))=o.origin
    AND substr(w.evidence_ref,length(o.origin)+1,1) IN ('','/','?','#')
)
WHERE w.source_key='linux:mail:reply-gap:v1'
  AND w.work_id IN (SELECT work_id FROM workboard_evidence_ref_host_remap_20261016);
