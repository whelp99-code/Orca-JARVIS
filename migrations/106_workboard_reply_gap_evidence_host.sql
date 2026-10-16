-- Remap legacy jm-acloud Mail reply-gap hosts in workboard_works.evidence_ref only.
-- Rollback: UPDATE workboard_works
--   SET evidence_ref = (
--     SELECT prior_evidence_ref FROM workboard_evidence_ref_host_remap_20261016 r
--     WHERE r.work_id = workboard_works.work_id
--   )
--   WHERE work_id IN (SELECT work_id FROM workboard_evidence_ref_host_remap_20261016);

CREATE TABLE workboard_evidence_ref_host_remap_20261016 (
  work_id TEXT PRIMARY KEY,
  prior_evidence_ref TEXT NOT NULL
);

INSERT INTO workboard_evidence_ref_host_remap_20261016 (work_id, prior_evidence_ref)
SELECT work_id, evidence_ref
FROM workboard_works
WHERE evidence_ref LIKE '%jm-acloud.alpines-goldeye.ts.net%'
   OR evidence_ref LIKE '%100.87.81.57%';

UPDATE workboard_works
SET evidence_ref = REPLACE(
  REPLACE(
    REPLACE(
      REPLACE(
        REPLACE(
          REPLACE(
            REPLACE(evidence_ref,
              'http://100.87.81.57:3010',
              'https://jm-omachy.alpines-goldeye.ts.net:8451'),
            'https://100.87.81.57:3010',
            'https://jm-omachy.alpines-goldeye.ts.net:8451'),
          'http://100.87.81.57:8451',
          'https://jm-omachy.alpines-goldeye.ts.net:8451'),
        'https://100.87.81.57:8451',
        'https://jm-omachy.alpines-goldeye.ts.net:8451'),
      'http://jm-acloud.alpines-goldeye.ts.net:3010',
      'https://jm-omachy.alpines-goldeye.ts.net:8451'),
    'https://jm-acloud.alpines-goldeye.ts.net:3010',
      'https://jm-omachy.alpines-goldeye.ts.net:8451'),
  'http://jm-acloud.alpines-goldeye.ts.net:8451',
  'https://jm-omachy.alpines-goldeye.ts.net:8451')
WHERE work_id IN (SELECT work_id FROM workboard_evidence_ref_host_remap_20261016);
