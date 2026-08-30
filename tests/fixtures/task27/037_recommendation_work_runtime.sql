CREATE TABLE recommendation_work_verifier_bindings (
 binding_id TEXT PRIMARY KEY, key_id TEXT NOT NULL UNIQUE REFERENCES trusted_authority_keys(key_id),
 principal_id TEXT NOT NULL UNIQUE, session_id TEXT NOT NULL UNIQUE, incarnation_id TEXT NOT NULL UNIQUE,
 revocation_reference TEXT NOT NULL UNIQUE,
 not_before TEXT NOT NULL CHECK(not_before GLOB '????-??-??T??:??:??.???Z'),
 expires_at TEXT NOT NULL CHECK(expires_at GLOB '????-??-??T??:??:??.???Z' AND expires_at>not_before),
 created_at TEXT NOT NULL CHECK(created_at GLOB '????-??-??T??:??:??.???Z')
);
CREATE INDEX recommendation_work_verifier_validity ON recommendation_work_verifier_bindings(not_before,expires_at,key_id);
CREATE TRIGGER recommendation_work_verifier_authority BEFORE INSERT ON recommendation_work_verifier_bindings
 WHEN NOT EXISTS (SELECT 1 FROM trusted_authority_keys k JOIN authority_key_purposes p ON p.key_id=k.key_id
  WHERE k.key_id=NEW.key_id AND k.principal_id=NEW.principal_id AND p.purpose='verifier')
 BEGIN SELECT RAISE(ABORT,'independent verifier authority required'); END;
CREATE TRIGGER recommendation_work_verifier_update BEFORE UPDATE ON recommendation_work_verifier_bindings
 BEGIN SELECT RAISE(ABORT,'immutable recommendation work verifier'); END;
CREATE TRIGGER recommendation_work_verifier_delete BEFORE DELETE ON recommendation_work_verifier_bindings
 BEGIN SELECT RAISE(ABORT,'immutable recommendation work verifier'); END;
CREATE TABLE recommendation_work_provider_bindings (
 binding_id TEXT PRIMARY KEY,
 key_id TEXT NOT NULL UNIQUE,
 purpose TEXT NOT NULL UNIQUE CHECK(purpose IN ('dispatch','progress')),
 provider TEXT NOT NULL CHECK(provider IN ('codex','claude')),
 endpoint_scope TEXT NOT NULL CHECK(endpoint_scope='recommendation-work'),
 public_key_pem TEXT NOT NULL,
 revocation_reference TEXT NOT NULL UNIQUE,
 not_before TEXT NOT NULL CHECK(not_before GLOB '????-??-??T??:??:??.???Z'),
 expires_at TEXT NOT NULL CHECK(expires_at GLOB '????-??-??T??:??:??.???Z' AND expires_at>not_before),
 created_at TEXT NOT NULL CHECK(created_at GLOB '????-??-??T??:??:??.???Z')
);
CREATE INDEX recommendation_work_provider_validity
 ON recommendation_work_provider_bindings(purpose,provider,not_before,expires_at,key_id);
CREATE TRIGGER recommendation_work_provider_update BEFORE UPDATE ON recommendation_work_provider_bindings
 BEGIN SELECT RAISE(ABORT,'immutable recommendation work provider'); END;
CREATE TRIGGER recommendation_work_provider_delete BEFORE DELETE ON recommendation_work_provider_bindings
 BEGIN SELECT RAISE(ABORT,'immutable recommendation work provider'); END;
CREATE TABLE recommendation_work_runtimes (
 runtime_id TEXT PRIMARY KEY CHECK(runtime_id GLOB 'recommendation-work:[0-9a-f]*' AND length(runtime_id)=84),
 request_id TEXT NOT NULL UNIQUE REFERENCES control_command_requests(request_id),
 run_id TEXT NOT NULL UNIQUE REFERENCES workflow_runs(run_id),
 identity_json TEXT NOT NULL CHECK(json_valid(identity_json)),
 identity_digest TEXT NOT NULL UNIQUE CHECK(identity_digest GLOB 'sha256:[0-9a-f]*' AND length(identity_digest)=71),
 workflow_digest TEXT NOT NULL CHECK(workflow_digest GLOB 'sha256:[0-9a-f]*' AND length(workflow_digest)=71),
 dispatch_intent_id TEXT NOT NULL UNIQUE,
 verification_request_id TEXT NOT NULL UNIQUE,
 state TEXT NOT NULL CHECK(state IN
('prepared','dispatching','dispatched','progressed','verified','recovering','blocked','failed','completed','cancelled')),
 dispatch_attempts INTEGER NOT NULL DEFAULT 0 CHECK(dispatch_attempts>=0),
 recovery_attempts INTEGER NOT NULL DEFAULT 0 CHECK(recovery_attempts>=0),
 progress_sequence INTEGER NOT NULL DEFAULT 0 CHECK(progress_sequence>=0),
 lease_owner TEXT,
 lease_fence INTEGER NOT NULL DEFAULT 0 CHECK(lease_fence>=0),
 lease_expires_at TEXT,
 failure_code TEXT,
 current_incarnation_id TEXT,
 current_dispatch_receipt_id TEXT,
 cancel_request_id TEXT REFERENCES recommendation_work_cancel_requests(cancel_id),
 created_at TEXT NOT NULL CHECK(created_at GLOB '????-??-??T??:??:??.???Z'),
 updated_at TEXT NOT NULL CHECK(updated_at GLOB '????-??-??T??:??:??.???Z'),
 CHECK((lease_owner IS NULL)=(lease_expires_at IS NULL)),
 CHECK(state NOT IN ('completed','cancelled') OR failure_code IS NULL OR state='cancelled')
);
CREATE INDEX recommendation_work_runtime_state ON recommendation_work_runtimes(state,updated_at,runtime_id);
CREATE INDEX recommendation_work_runtime_lease ON recommendation_work_runtimes(lease_expires_at,lease_fence);
CREATE TABLE recommendation_work_cancel_requests (
 cancel_id TEXT PRIMARY KEY,
 runtime_id TEXT NOT NULL UNIQUE REFERENCES recommendation_work_runtimes(runtime_id),
 request_json TEXT NOT NULL CHECK(json_valid(request_json)),
 request_digest TEXT NOT NULL UNIQUE CHECK(request_digest GLOB 'sha256:[0-9a-f]*' AND length(request_digest)=71),
 reason TEXT NOT NULL,
 lease_fence INTEGER NOT NULL CHECK(lease_fence>0),
 state TEXT NOT NULL CHECK(state IN ('pending','resolved')),
 outcome TEXT CHECK(outcome IN ('cancelled','dispatch_won')),
 created_at TEXT NOT NULL CHECK(created_at GLOB '????-??-??T??:??:??.???Z'),
 resolved_at TEXT CHECK(resolved_at IS NULL OR resolved_at GLOB '????-??-??T??:??:??.???Z'),
 CHECK((state='pending' AND outcome IS NULL AND resolved_at IS NULL)
  OR (state='resolved' AND outcome IS NOT NULL AND resolved_at IS NOT NULL))
);
CREATE INDEX recommendation_work_cancel_state ON recommendation_work_cancel_requests(state,created_at,cancel_id);
CREATE TRIGGER recommendation_work_cancel_identity BEFORE UPDATE OF cancel_id,runtime_id,request_json,
 request_digest,reason,lease_fence,created_at ON recommendation_work_cancel_requests
 BEGIN SELECT RAISE(ABORT,'immutable recommendation work cancel identity'); END;
CREATE TRIGGER recommendation_work_cancel_transition BEFORE UPDATE OF state,outcome,resolved_at
 ON recommendation_work_cancel_requests WHEN NOT (OLD.state='pending' AND NEW.state='resolved'
 AND NEW.outcome IS NOT NULL AND NEW.resolved_at IS NOT NULL)
 BEGIN SELECT RAISE(ABORT,'recommendation work cancel transition invalid'); END;
CREATE TRIGGER recommendation_work_cancel_delete BEFORE DELETE ON recommendation_work_cancel_requests
 BEGIN SELECT RAISE(ABORT,'immutable recommendation work cancel'); END;
CREATE TABLE recommendation_work_dispatch_attempts (
 attempt_id TEXT PRIMARY KEY, runtime_id TEXT NOT NULL REFERENCES recommendation_work_runtimes(runtime_id),
 lease_fence INTEGER NOT NULL CHECK(lease_fence>0), attempt INTEGER NOT NULL CHECK(attempt>0),
 state TEXT NOT NULL CHECK(state IN ('prepared','not_sent','accepted','uncertain')),
 event_id TEXT, evidence_digest TEXT CHECK(evidence_digest IS NULL OR (evidence_digest GLOB 'sha256:[0-9a-f]*' AND length(evidence_digest)=71)),
 created_at TEXT NOT NULL CHECK(created_at GLOB '????-??-??T??:??:??.???Z'),
 updated_at TEXT NOT NULL CHECK(updated_at GLOB '????-??-??T??:??:??.???Z'), UNIQUE(runtime_id,attempt),
 CHECK((state='prepared' AND event_id IS NULL AND evidence_digest IS NULL) OR state<>'prepared')
);
CREATE INDEX recommendation_work_attempt_runtime ON recommendation_work_dispatch_attempts(runtime_id,state,attempt);
CREATE TABLE recommendation_work_dispatch_receipts (
 receipt_id TEXT PRIMARY KEY, runtime_id TEXT NOT NULL REFERENCES recommendation_work_runtimes(runtime_id),
 attempt_id TEXT NOT NULL UNIQUE REFERENCES recommendation_work_dispatch_attempts(attempt_id),
 incarnation_id TEXT NOT NULL, receipt_json TEXT NOT NULL CHECK(json_valid(receipt_json)),
 receipt_digest TEXT NOT NULL UNIQUE CHECK(receipt_digest GLOB 'sha256:[0-9a-f]*' AND length(receipt_digest)=71),
 accepted_at TEXT NOT NULL CHECK(accepted_at GLOB '????-??-??T??:??:??.???Z'), UNIQUE(runtime_id,incarnation_id)
);
CREATE INDEX recommendation_work_receipt_runtime ON recommendation_work_dispatch_receipts(runtime_id,accepted_at,receipt_id);
CREATE TABLE recommendation_work_progress (
 event_id TEXT PRIMARY KEY CHECK(event_id GLOB 'sha256:[0-9a-f]*' AND length(event_id)=71),
 runtime_id TEXT NOT NULL REFERENCES recommendation_work_runtimes(runtime_id),
 dispatch_receipt_id TEXT NOT NULL REFERENCES recommendation_work_dispatch_receipts(receipt_id),
 sequence INTEGER NOT NULL CHECK(sequence>0), signal_json TEXT NOT NULL CHECK(json_valid(signal_json)),
 signal_digest TEXT NOT NULL UNIQUE CHECK(signal_digest GLOB 'sha256:[0-9a-f]*' AND length(signal_digest)=71),
 observed_at TEXT NOT NULL CHECK(observed_at GLOB '????-??-??T??:??:??.???Z'),
 UNIQUE(runtime_id,dispatch_receipt_id,sequence)
);
CREATE INDEX recommendation_work_progress_runtime ON recommendation_work_progress(runtime_id,sequence,event_id);
CREATE TABLE recommendation_work_nonterminal_events (
 event_id TEXT PRIMARY KEY, runtime_id TEXT NOT NULL REFERENCES recommendation_work_runtimes(runtime_id),
 kind TEXT NOT NULL CHECK(kind IN ('worker_done','idle','prompt','self_review')),
 created_at TEXT NOT NULL CHECK(created_at GLOB '????-??-??T??:??:??.???Z')
);
CREATE INDEX recommendation_work_event_runtime ON recommendation_work_nonterminal_events(runtime_id,created_at,event_id);
CREATE TABLE recommendation_work_verification_requests (
 verification_request_id TEXT PRIMARY KEY, runtime_id TEXT NOT NULL REFERENCES recommendation_work_runtimes(runtime_id),
 run_id TEXT NOT NULL REFERENCES workflow_runs(run_id), dispatch_receipt_id TEXT NOT NULL REFERENCES
recommendation_work_dispatch_receipts(receipt_id),
 request_json TEXT NOT NULL CHECK(json_valid(request_json)), request_digest TEXT NOT NULL UNIQUE CHECK(request_digest GLOB 'sha256:[0-9a-f]*' AND
length(request_digest)=71),
 commit_digest TEXT NOT NULL CHECK(commit_digest GLOB 'sha256:[0-9a-f]*' AND length(commit_digest)=71),
 artifact_digest TEXT NOT NULL CHECK(artifact_digest GLOB 'sha256:[0-9a-f]*' AND length(artifact_digest)=71),
 test_digest TEXT NOT NULL CHECK(test_digest GLOB 'sha256:[0-9a-f]*' AND length(test_digest)=71),
 evidence_digest TEXT NOT NULL CHECK(evidence_digest GLOB 'sha256:[0-9a-f]*' AND length(evidence_digest)=71),
 created_at TEXT NOT NULL CHECK(created_at GLOB '????-??-??T??:??:??.???Z')
);
CREATE TABLE recommendation_work_verification_receipts (
 receipt_id TEXT PRIMARY KEY, runtime_id TEXT NOT NULL REFERENCES recommendation_work_runtimes(runtime_id),
 verification_request_id TEXT NOT NULL UNIQUE REFERENCES recommendation_work_verification_requests(verification_request_id),
 receipt_json TEXT NOT NULL CHECK(json_valid(receipt_json)), receipt_digest TEXT NOT NULL UNIQUE CHECK(receipt_digest GLOB 'sha256:[0-9a-f]*' AND
length(receipt_digest)=71),
 decision TEXT NOT NULL CHECK(decision IN ('PASS','REJECT')), artifact_digest TEXT NOT NULL, test_digest TEXT NOT NULL,
 evidence_digest TEXT NOT NULL, commit_digest TEXT NOT NULL,
 created_at TEXT NOT NULL CHECK(created_at GLOB '????-??-??T??:??:??.???Z')
);
CREATE INDEX recommendation_work_verification_runtime ON recommendation_work_verification_receipts(runtime_id,decision,created_at);
CREATE TABLE recommendation_work_negative_evidence (
 evidence_id TEXT PRIMARY KEY, runtime_id TEXT NOT NULL REFERENCES recommendation_work_runtimes(runtime_id),
 reason_code TEXT NOT NULL, evidence_digest TEXT NOT NULL UNIQUE CHECK(evidence_digest GLOB 'sha256:[0-9a-f]*' AND length(evidence_digest)=71),
 created_at TEXT NOT NULL CHECK(created_at GLOB '????-??-??T??:??:??.???Z')
);
CREATE INDEX recommendation_work_negative_runtime ON recommendation_work_negative_evidence(runtime_id,created_at,evidence_id);
CREATE TABLE recommendation_work_settlements (
 settlement_id TEXT PRIMARY KEY, runtime_id TEXT NOT NULL UNIQUE REFERENCES recommendation_work_runtimes(runtime_id),
 outcome TEXT NOT NULL CHECK(outcome IN ('completed','failed','cancelled')), settlement_json TEXT NOT NULL CHECK(json_valid(settlement_json)),
 settlement_digest TEXT NOT NULL UNIQUE CHECK(settlement_digest GLOB 'sha256:[0-9a-f]*' AND length(settlement_digest)=71),
 created_at TEXT NOT NULL CHECK(created_at GLOB '????-??-??T??:??:??.???Z')
);
CREATE TABLE recommendation_verified_outcomes (
 candidate_id TEXT PRIMARY KEY, runtime_id TEXT NOT NULL UNIQUE REFERENCES recommendation_work_runtimes(runtime_id),
 payload_json TEXT NOT NULL CHECK(json_valid(payload_json)), payload_digest TEXT NOT NULL UNIQUE CHECK(payload_digest GLOB 'sha256:[0-9a-f]*' AND
length(payload_digest)=71),
 created_at TEXT NOT NULL CHECK(created_at GLOB '????-??-??T??:??:??.???Z')
);
CREATE INDEX recommendation_verified_outcome_created ON recommendation_verified_outcomes(created_at,candidate_id);
CREATE TRIGGER recommendation_work_runtime_delete BEFORE DELETE ON recommendation_work_runtimes
 BEGIN SELECT RAISE(ABORT,'immutable recommendation work runtime'); END;
CREATE TRIGGER recommendation_work_runtime_identity BEFORE UPDATE OF runtime_id,request_id,run_id,identity_json,
 identity_digest,workflow_digest,dispatch_intent_id,verification_request_id,created_at ON recommendation_work_runtimes
 BEGIN SELECT RAISE(ABORT,'immutable recommendation work identity'); END;
CREATE TRIGGER recommendation_work_runtime_fence BEFORE UPDATE OF state,dispatch_attempts,recovery_attempts,
 progress_sequence,current_incarnation_id,current_dispatch_receipt_id,cancel_request_id,failure_code
 ON recommendation_work_runtimes
 WHEN OLD.lease_owner IS NULL OR OLD.lease_fence<=0 OR OLD.lease_expires_at<=NEW.updated_at
 BEGIN SELECT RAISE(ABORT,'current recommendation work fence required'); END;
CREATE TRIGGER recommendation_work_runtime_lease BEFORE UPDATE OF lease_owner,lease_fence,lease_expires_at
 ON recommendation_work_runtimes WHEN NOT (NEW.lease_fence=OLD.lease_fence+1 AND NEW.lease_owner IS NOT NULL
 AND NEW.lease_expires_at>NEW.updated_at AND (OLD.lease_owner IS NULL OR OLD.lease_expires_at<=NEW.updated_at))
 BEGIN SELECT RAISE(ABORT,'recommendation work lease invalid'); END;
CREATE TRIGGER recommendation_work_runtime_transition BEFORE UPDATE OF state ON recommendation_work_runtimes
 WHEN OLD.state<>NEW.state AND OLD.state||':'||NEW.state NOT IN
 ('prepared:dispatching','prepared:dispatched','prepared:failed','prepared:cancelled',
 'dispatching:prepared','dispatching:blocked',
 'dispatching:dispatched','dispatched:progressed','dispatched:recovering','dispatched:cancelled',
 'progressed:verified','progressed:recovering','progressed:cancelled','verified:completed','verified:cancelled',
 'recovering:prepared','recovering:dispatched','recovering:failed','recovering:cancelled','blocked:dispatched',
 'blocked:cancelled','dispatching:cancelled')
 BEGIN SELECT RAISE(ABORT,'recommendation work transition invalid'); END;
CREATE TRIGGER recommendation_work_runtime_counters BEFORE UPDATE OF dispatch_attempts,recovery_attempts,
 progress_sequence ON recommendation_work_runtimes WHEN NEW.dispatch_attempts<OLD.dispatch_attempts
 OR NEW.dispatch_attempts>OLD.dispatch_attempts+1 OR NEW.recovery_attempts<OLD.recovery_attempts
 OR NEW.recovery_attempts>OLD.recovery_attempts+1 OR NEW.progress_sequence<0
 OR (NEW.progress_sequence<OLD.progress_sequence AND NOT
   (OLD.state='recovering' AND NEW.state='prepared' AND NEW.progress_sequence=0))
 OR NEW.progress_sequence>OLD.progress_sequence+1
 BEGIN SELECT RAISE(ABORT,'recommendation work counter invalid'); END;
CREATE TRIGGER recommendation_work_attempt_identity BEFORE UPDATE OF attempt_id,runtime_id,lease_fence,attempt,created_at ON
recommendation_work_dispatch_attempts BEGIN SELECT RAISE(ABORT,'immutable recommendation work attempt identity'); END;
CREATE TRIGGER recommendation_work_attempt_delete BEFORE DELETE ON recommendation_work_dispatch_attempts BEGIN SELECT RAISE(ABORT,'immutable
recommendation work attempt'); END;
CREATE TRIGGER recommendation_work_receipt_update BEFORE UPDATE ON recommendation_work_dispatch_receipts BEGIN SELECT RAISE(ABORT,'immutable
recommendation work dispatch receipt'); END;
CREATE TRIGGER recommendation_work_receipt_delete BEFORE DELETE ON recommendation_work_dispatch_receipts BEGIN SELECT RAISE(ABORT,'immutable
recommendation work dispatch receipt'); END;
CREATE TRIGGER recommendation_work_progress_update BEFORE UPDATE ON recommendation_work_progress BEGIN SELECT RAISE(ABORT,'immutable recommendation
work progress'); END;
CREATE TRIGGER recommendation_work_progress_delete BEFORE DELETE ON recommendation_work_progress BEGIN SELECT RAISE(ABORT,'immutable recommendation
work progress'); END;
CREATE TRIGGER recommendation_work_event_update BEFORE UPDATE ON recommendation_work_nonterminal_events BEGIN SELECT RAISE(ABORT,'immutable
recommendation work event'); END;
CREATE TRIGGER recommendation_work_event_delete BEFORE DELETE ON recommendation_work_nonterminal_events BEGIN SELECT RAISE(ABORT,'immutable
recommendation work event'); END;
CREATE TRIGGER recommendation_work_request_update BEFORE UPDATE ON recommendation_work_verification_requests BEGIN SELECT RAISE(ABORT,'immutable
recommendation work verification request'); END;
CREATE TRIGGER recommendation_work_request_delete BEFORE DELETE ON recommendation_work_verification_requests BEGIN SELECT RAISE(ABORT,'immutable
recommendation work verification request'); END;
CREATE TRIGGER recommendation_work_verification_update BEFORE UPDATE ON recommendation_work_verification_receipts BEGIN SELECT RAISE(ABORT,'immutable
recommendation work verification'); END;
CREATE TRIGGER recommendation_work_verification_delete BEFORE DELETE ON recommendation_work_verification_receipts BEGIN SELECT RAISE(ABORT,'immutable
recommendation work verification'); END;
CREATE TRIGGER recommendation_work_negative_update BEFORE UPDATE ON recommendation_work_negative_evidence BEGIN SELECT RAISE(ABORT,'immutable
recommendation work negative evidence'); END;
CREATE TRIGGER recommendation_work_negative_delete BEFORE DELETE ON recommendation_work_negative_evidence BEGIN SELECT RAISE(ABORT,'immutable
recommendation work negative evidence'); END;
CREATE TRIGGER recommendation_work_settlement_update BEFORE UPDATE ON recommendation_work_settlements BEGIN SELECT RAISE(ABORT,'immutable
recommendation work settlement'); END;
CREATE TRIGGER recommendation_work_settlement_delete BEFORE DELETE ON recommendation_work_settlements BEGIN SELECT RAISE(ABORT,'immutable
recommendation work settlement'); END;
CREATE TRIGGER recommendation_verified_outcome_update BEFORE UPDATE ON recommendation_verified_outcomes BEGIN SELECT RAISE(ABORT,'immutable
recommendation verified outcome'); END;
CREATE TRIGGER recommendation_verified_outcome_delete BEFORE DELETE ON recommendation_verified_outcomes BEGIN SELECT RAISE(ABORT,'immutable
recommendation verified outcome'); END;
