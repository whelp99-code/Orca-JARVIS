CREATE TABLE negative_evidence (
  evidence_id TEXT NOT NULL PRIMARY KEY,
  task_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  reason_code TEXT NOT NULL CHECK(reason_code IN ('invalid_assumption','failed_approach','blocked_dependency','verification_failure','external_uncertain')),
  scope_json TEXT NOT NULL,
  summary TEXT NOT NULL,
  evidence_digest TEXT NOT NULL,
  request_id TEXT NOT NULL UNIQUE REFERENCES control_command_requests(request_id),
  receipt_id TEXT NOT NULL UNIQUE REFERENCES control_command_receipts(receipt_id),
  created_at TEXT NOT NULL
);
CREATE INDEX negative_evidence_task ON negative_evidence(task_id,created_at,evidence_id);
CREATE INDEX negative_evidence_reason ON negative_evidence(reason_code,created_at,evidence_id);
CREATE TRIGGER negative_evidence_authority_guard BEFORE INSERT ON negative_evidence WHEN NOT EXISTS (
  SELECT 1
  FROM control_command_requests r
  JOIN control_command_receipts a ON a.request_id=r.request_id AND a.receipt_id=NEW.receipt_id
  JOIN control_command_redemptions x ON x.request_id=r.request_id AND x.receipt_id=a.receipt_id AND x.lease_fence=r.lease_fence
  WHERE r.request_id=NEW.request_id
    AND r.action='evidence.negative.record'
    AND r.action_level=2
    AND r.state='claimed'
    AND a.decision='approve'
    AND a.command_digest=r.command_digest
    AND json(r.args_json)=json_object(
      'attempt_id',NEW.attempt_id,
      'evidence_digest',NEW.evidence_digest,
      'reason_code',NEW.reason_code,
      'schema_version',1,
      'scope',json(NEW.scope_json),
      'summary',NEW.summary,
      'task_id',NEW.task_id
    )
) BEGIN SELECT RAISE(ABORT,'negative evidence authority required'); END;
CREATE TRIGGER negative_evidence_known_task_guard BEFORE INSERT ON negative_evidence WHEN NOT EXISTS (SELECT 1 FROM work_items WHERE id=NEW.task_id) AND NOT EXISTS (SELECT 1 FROM workflow_runs WHERE run_id=NEW.task_id OR correlation_id=NEW.task_id OR json_extract(input_json,'$.task_id')=NEW.task_id) AND NOT EXISTS (SELECT 1 FROM gjc_intents WHERE intent_id=NEW.task_id OR continuation_id=NEW.task_id) AND NOT EXISTS (SELECT 1 FROM control_command_requests WHERE action<>'evidence.negative.record' AND (request_id=NEW.task_id OR json_extract(target_json,'$.task_id')=NEW.task_id OR json_extract(args_json,'$.task_id')=NEW.task_id)) BEGIN SELECT RAISE(ABORT,'negative evidence task required'); END;
CREATE TRIGGER negative_evidence_immutable_update BEFORE UPDATE ON negative_evidence BEGIN SELECT RAISE(ABORT,'immutable negative evidence'); END;
CREATE TRIGGER negative_evidence_immutable_delete BEFORE DELETE ON negative_evidence BEGIN SELECT RAISE(ABORT,'immutable negative evidence'); END;
