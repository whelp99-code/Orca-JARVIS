import { approvedMemoryDecisionIsCurrent } from "./memory-candidate-authority.js";
import { parseMemoryCandidateInput } from "./memory-candidate-input.js";
import { computeMemoryCandidate } from "./memory-candidate-material.js";
import {
  parseMemoryCandidatePolicy,
  type ParsedMemoryCandidatePolicy,
} from "./memory-candidate-policy.js";
import { readMemoryCandidate } from "./memory-candidate-reader.js";
import {
  MEMORY_CANDIDATE_DIGEST_DOMAINS,
  type MemoryCandidateClassification,
  type MemoryCandidateComputation,
  type ParsedMemoryCandidateInput,
} from "./memory-candidate-types.js";
import { memoryDate, memoryFail, memoryHash } from "./memory-candidate-values.js";
import type { AuthorityDb } from "./db.js";
import { persistenceRow, persistenceText } from "./personal-persistence-values.js";

type PersistContext = {
  readonly input: ParsedMemoryCandidateInput;
  readonly now: Date;
  readonly preliminary: MemoryCandidateComputation;
};

type IdempotencyInsert = {
  readonly computation: MemoryCandidateComputation;
  readonly candidate_id: string;
  readonly created_at: string;
};

export class MemoryCandidateStore {
  private readonly policy: ParsedMemoryCandidatePolicy;

  constructor(
    private readonly authority: AuthorityDb,
    policyValue: unknown,
    private readonly clock: () => unknown,
  ) {
    this.policy = parseMemoryCandidatePolicy(policyValue);
  }

  classify(value: unknown): MemoryCandidateClassification {
    const input = parseMemoryCandidateInput(value);
    const now = memoryDate(this.clock());
    const preliminary = computeMemoryCandidate(this.policy, input, {
      now,
      approved_decision_valid: true,
    });
    const replay = this.replay(preliminary);
    if (replay !== undefined) return replay;
    return this.authority.db.transaction(() => this.persist({ input, now, preliminary })).immediate();
  }

  private replay(computation: MemoryCandidateComputation): MemoryCandidateClassification | undefined {
    const value = this.authority.db.prepare(
      "SELECT request_digest,candidate_id FROM memory_candidate_idempotency WHERE idempotency_digest=?",
    ).get(computation.idempotency_digest);
    if (value === undefined) return undefined;
    const row = persistenceRow(value);
    if (row["request_digest"] !== computation.request_digest) {
      return memoryFail("MEMORY_CANDIDATE_REPLAY_CONFLICT");
    }
    const stored = readMemoryCandidate(this.authority.db, persistenceText(row["candidate_id"]));
    return stored ?? memoryFail("MEMORY_CANDIDATE_INTEGRITY_FAILURE");
  }

  private persist(context: PersistContext): MemoryCandidateClassification {
    const replay = this.replay(context.preliminary);
    if (replay !== undefined) return replay;
    const decisionValid = approvedMemoryDecisionIsCurrent(this.authority.db, context.input, context.now);
    const computation = computeMemoryCandidate(this.policy, context.input, {
      now: context.now,
      approved_decision_valid: decisionValid,
    });
    const existingValue = this.authority.db.prepare(
      "SELECT candidate_id,input_digest,created_at FROM memory_candidate_classifications WHERE dedup_key=?",
    ).get(computation.classification.dedup_key);
    if (existingValue !== undefined) {
      const existing = persistenceRow(existingValue);
      if (existing["input_digest"] !== computation.input_digest) {
        return memoryFail("MEMORY_CANDIDATE_REPLAY_CONFLICT");
      }
      const candidateId = persistenceText(existing["candidate_id"]);
      this.insertIdempotency({
        computation,
        candidate_id: candidateId,
        created_at: persistenceText(existing["created_at"]),
      });
      return readMemoryCandidate(this.authority.db, candidateId)
        ?? memoryFail("MEMORY_CANDIDATE_INTEGRITY_FAILURE");
    }
    this.insertCandidate(computation, context.input);
    return computation.classification;
  }

  private insertIdempotency(input: IdempotencyInsert): void {
    this.authority.db.prepare(
      `INSERT INTO memory_candidate_idempotency(
        idempotency_digest,request_digest,input_digest,candidate_id,created_at
       ) VALUES(?,?,?,?,?)`,
    ).run(
      input.computation.idempotency_digest,
      input.computation.request_digest,
      input.computation.input_digest,
      input.candidate_id,
      input.created_at,
    );
  }

  private insertCandidate(computation: MemoryCandidateComputation, input: ParsedMemoryCandidateInput): void {
    const result = computation.classification;
    const correlationId = `corr:memory:${result.candidate_id.slice("memcand:pos:v1:".length)}`;
    this.authority.db.prepare(
      `INSERT INTO memory_candidates(
        candidate_id,correlation_id,idempotency_key,candidate_kind,operation,subject_digest,content_digest,
        source_digest,sensitivity,purpose,required_confirmation,state,confirmation_expires_at,expires_at,
        created_at,updated_at
       ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      result.candidate_id,
      correlationId,
      computation.idempotency_digest,
      result.candidate_kind,
      result.operation,
      result.subject_digest,
      result.content_digest,
      result.source_digest,
      result.storage_sensitivity,
      result.purpose,
      result.required_confirmation ? 1 : 0,
      "proposed",
      result.confirmation_expires_at,
      result.candidate_expires_at,
      result.created_at,
      result.created_at,
    );
    this.authority.db.prepare(
      `INSERT INTO memory_candidate_classifications(
        candidate_id,schema_version,input_digest,candidate_digest,input_class,confidence,policy_sensitivity,
        retention_days,confirmation_gate,policy_digest,classification_reason,classification_digest,dedup_key,
        source_id,source_version,owner_principal,authenticated_session_id,worker_id,verifier_id,
        control_request_id,control_receipt_id,control_command_digest,inference_label,conflict_state,
        delivery_state,delivery_reason,created_at
       ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      result.candidate_id,
      result.schema_version,
      computation.input_digest,
      result.candidate_digest,
      result.input_class,
      result.confidence,
      result.policy_sensitivity,
      result.retention_days,
      result.confirmation_gate,
      result.policy_digest,
      result.classification_reason,
      result.classification_digest,
      result.dedup_key,
      result.source.source_id,
      result.source.source_version,
      result.source.principal_id,
      result.source.authenticated_session_id,
      result.source.worker_id,
      result.source.verifier_id,
      result.source.request_id,
      result.source.receipt_id,
      result.source.command_digest,
      result.source.inference_label,
      result.conflict_state,
      result.delivery.state,
      result.delivery.reason,
      result.created_at,
    );
    const insertReference = this.authority.db.prepare(
      `INSERT INTO memory_candidate_source_refs(
        candidate_id,position,ref_kind,source_ref,evidence_digest,observed_at,fresh_until,expires_at
       ) VALUES(?,?,?,?,?,?,?,?)`,
    );
    for (const reference of result.source_refs) {
      insertReference.run(
        result.candidate_id,
        reference.position,
        reference.kind,
        reference.source_ref,
        reference.evidence_digest,
        reference.observed_at,
        reference.fresh_until,
        reference.expires_at,
      );
    }
    this.insertIdempotency({
      computation,
      candidate_id: result.candidate_id,
      created_at: result.created_at,
    });
    const eventDigest = memoryHash(MEMORY_CANDIDATE_DIGEST_DOMAINS.audit, {
      candidate_id: result.candidate_id,
      classification_digest: result.classification_digest,
      state: result.state,
    });
    this.authority.db.prepare(
      `INSERT INTO personal_operation_audit_events(
        event_id,event_type,subject_kind,subject_id,principal_id,correlation_id,causation_id,event_digest,created_at
       ) VALUES(?,?,?,?,?,?,?,?,?)`,
    ).run(
      `event:memory:${eventDigest.slice(7)}`,
      `memory.candidate.${result.state}`,
      "memory_candidate",
      result.candidate_id,
      input.principal_id,
      correlationId,
      result.source.request_id,
      eventDigest,
      result.created_at,
    );
    if (result.state === "rejected" || result.state === "expired") {
      this.authority.db.prepare(
        "UPDATE memory_candidates SET state=?,updated_at=? WHERE candidate_id=?",
      ).run(result.state, result.created_at, result.candidate_id);
      return;
    }
    this.authority.db.prepare(
      "UPDATE memory_candidates SET state='classified',updated_at=? WHERE candidate_id=?",
    ).run(result.created_at, result.candidate_id);
    if (result.state !== "classified") {
      this.authority.db.prepare(
        "UPDATE memory_candidates SET state=?,updated_at=? WHERE candidate_id=?",
      ).run(result.state, result.created_at, result.candidate_id);
    }
  }
}
