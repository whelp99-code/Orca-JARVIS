-- Task 30 V2 correction, deletion, and export request authority journal.
CREATE TABLE memory_effect_requests (
  request_id TEXT PRIMARY KEY CHECK(substr(request_id,1,14)='memeff:req:v2:' AND length(request_id)=78 AND substr(request_id,15) NOT GLOB '*[^0-9a-f]*'),
  schema_version INTEGER NOT NULL DEFAULT 2 CHECK(schema_version=2),
  request_digest TEXT NOT NULL UNIQUE CHECK(request_digest GLOB 'sha256:[0-9a-f]*' AND length(request_digest)=71),
  idempotency_key TEXT NOT NULL UNIQUE CHECK(substr(idempotency_key,1,15)='memeff:idem:v2:' AND length(idempotency_key)=79 AND substr(idempotency_key,16) NOT GLOB '*[^0-9a-f]*'),
  envelope_digest TEXT NOT NULL UNIQUE CHECK(envelope_digest GLOB 'sha256:[0-9a-f]*' AND length(envelope_digest)=71),
  provider_instance_id TEXT NOT NULL,
  lane TEXT NOT NULL CHECK(lane IN ('correction','deletion','export')),
  lane_id TEXT NOT NULL UNIQUE,
  operation TEXT NOT NULL CHECK(operation IN ('correct','forget','export')),
  target_manifest_digest TEXT NOT NULL,
  scope_digest TEXT NOT NULL,
  delegation_id TEXT NOT NULL UNIQUE,
  request_json TEXT NOT NULL,
  control_request_id TEXT NOT NULL UNIQUE REFERENCES control_command_requests(request_id),
  control_receipt_id TEXT NOT NULL UNIQUE REFERENCES control_command_receipts(receipt_id),
  state TEXT NOT NULL CHECK(state IN ('prepared','accepted','applying','completed','failed','uncertain')),
  provider_result_json TEXT,
  provider_result_digest TEXT UNIQUE,
  failure_code TEXT,
  created_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',created_at)=created_at),
  updated_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',updated_at)=updated_at),
  completed_at TEXT CHECK(completed_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ',completed_at)=completed_at),
  CHECK((provider_result_json IS NULL)=(provider_result_digest IS NULL)),
  CHECK((state='completed')=(completed_at IS NOT NULL))
);
CREATE INDEX memory_effect_requests_state ON memory_effect_requests(state,updated_at,request_id);
CREATE INDEX memory_effect_requests_lane ON memory_effect_requests(lane,created_at,request_id);

CREATE TRIGGER memory_effect_requests_authority BEFORE INSERT ON memory_effect_requests
WHEN NOT EXISTS (
  SELECT 1 FROM control_command_requests r
  JOIN control_command_redemptions x ON x.request_id=r.request_id AND x.lease_fence=r.lease_fence
  JOIN control_command_receipts a ON a.receipt_id=x.receipt_id AND a.request_id=r.request_id
  WHERE r.request_id=NEW.control_request_id AND x.receipt_id=NEW.control_receipt_id
    AND r.state='claimed' AND a.decision='approve' AND r.command_digest=a.command_digest
    AND ((NEW.operation='correct' AND r.action='memory.correct' AND r.action_level>=3)
      OR (NEW.operation='export' AND r.action='memory.export' AND r.action_level>=3)
      OR (NEW.operation='forget' AND r.action='memory.forget' AND r.action_level>=4))
    AND json_extract(r.args_json,'$.schema_version')=2
    AND json_extract(r.args_json,'$.request.request_id')=NEW.request_id
    AND json_extract(r.args_json,'$.request.request_digest')=NEW.request_digest
    AND json_extract(r.args_json,'$.request.envelope_digest')=NEW.envelope_digest
)
BEGIN SELECT RAISE(ABORT,'memory effect authority required'); END;

CREATE TRIGGER memory_effect_requests_identity_immutable BEFORE UPDATE OF
  request_id,schema_version,request_digest,idempotency_key,envelope_digest,provider_instance_id,
  lane,lane_id,operation,target_manifest_digest,scope_digest,delegation_id,request_json,
  control_request_id,control_receipt_id,created_at ON memory_effect_requests
BEGIN SELECT RAISE(ABORT,'immutable memory effect request'); END;

CREATE TRIGGER memory_effect_requests_transition BEFORE UPDATE OF state ON memory_effect_requests
WHEN OLD.state<>NEW.state AND OLD.state||':'||NEW.state NOT IN (
  'prepared:accepted','prepared:failed','prepared:uncertain','accepted:applying',
  'accepted:failed','accepted:uncertain','applying:completed','applying:failed','applying:uncertain',
  'uncertain:accepted','uncertain:applying','uncertain:completed','uncertain:failed'
)
BEGIN SELECT RAISE(ABORT,'memory effect transition invalid'); END;
