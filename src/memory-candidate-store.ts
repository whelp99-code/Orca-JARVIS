import { recoverUncommittedCandidateReview } from "./memory-candidate-review-recovery.js";
import { claimMemoryCandidateAuthority, requireMemoryCandidateAuthority } from "./memory-candidate-authority.js";
import type { MemoryAuthorityResolution } from "./memory-candidate-authority-types.js";
import { parseMemoryCandidateInput } from "./memory-candidate-input.js";
import { computeMemoryCandidate, memoryCandidateIdentity } from "./memory-candidate-material.js";
import { parseMemoryCandidatePolicy, type ParsedMemoryCandidatePolicy } from "./memory-candidate-policy.js";
import { readMemoryCandidate } from "./memory-candidate-reader.js";
import {
  createMemoryCandidateReviewEnvelope,
  MemoryCandidateReviewSpool,
  type MemoryCandidateReviewPublication,
} from "./memory-candidate-review-spool.js";
import {
  MEMORY_CANDIDATE_DIGEST_DOMAINS,
  type MemoryCandidateClassification,
  type MemoryCandidateComputation,
  type ParsedMemoryCandidateInput,
} from "./memory-candidate-types.js";
import { memoryDate, memoryFail, memoryHash } from "./memory-candidate-values.js";
import type { AuthorityDb } from "./db.js";
import { persistenceRow, persistenceText } from "./personal-persistence-values.js";

type IdempotencyInsert = { readonly computation: MemoryCandidateComputation; readonly candidate_id: string; readonly created_at: string };

export class MemoryCandidateStore {
  private readonly policy: ParsedMemoryCandidatePolicy;
  private reviewSpool: MemoryCandidateReviewSpool | undefined;

  constructor(private readonly authority: AuthorityDb, policyValue: unknown, private readonly clock: () => unknown) {
    this.policy = parseMemoryCandidatePolicy(policyValue);
  }

  attachReviewSpool(root: string): void {
    this.reviewSpool = new MemoryCandidateReviewSpool(root);
  }

  classify(value: unknown): MemoryCandidateClassification {
    const input = parseMemoryCandidateInput(value);
    // Read-only preflight; repeat under the writer lock after any lock wait.
    requireMemoryCandidateAuthority(this.authority.db,
      { input, identity: memoryCandidateIdentity(input), now: memoryDate(this.clock()) });
    let publication: MemoryCandidateReviewPublication | undefined;
    try {
      return this.authority.db.transaction(() => this.persist(input, value => { publication = value; })).immediate();
    } catch (error) {
      const failedPublication = publication;
      if (failedPublication?.created === true) this.authority.db.transaction(() => {
        // Another writer may adopt the file after this transaction rolls back.
        if (this.authority.db.prepare("SELECT 1 FROM memory_candidates WHERE candidate_id=?")
          .get(failedPublication.candidate_id) === undefined) this.reviewSpool?.remove(failedPublication);
      }).immediate();
      throw error;
    }
  }

  private replay(computation: MemoryCandidateComputation): MemoryCandidateClassification | undefined {
    const value = this.authority.db.prepare(
      "SELECT request_digest,candidate_id FROM memory_candidate_idempotency WHERE idempotency_digest=?",
    ).get(computation.idempotency_digest);
    if (value === undefined) return undefined;
    const row = persistenceRow(value);
    if (row["request_digest"] !== computation.request_digest) return memoryFail("MEMORY_CANDIDATE_REPLAY_CONFLICT");
    return readMemoryCandidate(this.authority.db, persistenceText(row["candidate_id"]))
      ?? memoryFail("MEMORY_CANDIDATE_INTEGRITY_FAILURE");
  }

  private persist(input: ParsedMemoryCandidateInput, onPublication: (value: MemoryCandidateReviewPublication) => void): MemoryCandidateClassification {
    const now = memoryDate(this.clock());
    const authority = requireMemoryCandidateAuthority(this.authority.db, {
      input,
      identity: memoryCandidateIdentity(input),
      now,
    });
    let computation = computeMemoryCandidate(this.policy, input, { now, authority });
    const replay = this.replay(computation);
    if (replay !== undefined) return replay;
    const existingValue = this.authority.db.prepare(
      "SELECT candidate_id,input_digest,created_at FROM memory_candidate_classifications WHERE dedup_key=?",
    ).get(computation.classification.dedup_key);
    if (existingValue !== undefined) {
      const existing = persistenceRow(existingValue);
      if (existing["input_digest"] !== computation.input_digest) return memoryFail("MEMORY_CANDIDATE_REPLAY_CONFLICT");
      const candidateId = persistenceText(existing["candidate_id"]);
      this.insertIdempotency({ computation, candidate_id: candidateId, created_at: persistenceText(existing["created_at"]) });
      return readMemoryCandidate(this.authority.db, candidateId) ?? memoryFail("MEMORY_CANDIDATE_INTEGRITY_FAILURE");
    }
    if (this.authority.db.prepare("SELECT 1 FROM memory_candidates WHERE candidate_id=?")
      .get(computation.classification.candidate_id) !== undefined) return memoryFail("MEMORY_CANDIDATE_INTEGRITY_FAILURE");
    let publication: MemoryCandidateReviewPublication | undefined;
    if (computation.classification.state === "awaiting_confirmation" && this.reviewSpool !== undefined) {
      computation = recoverUncommittedCandidateReview(this.reviewSpool, this.policy, input, authority, computation, now);
      publication = this.reviewSpool.publish(createMemoryCandidateReviewEnvelope({ input, computation,
        classification: computation.classification }));
      onPublication(publication);
      // File fsync may consume the remaining source/approval lifetime. Recheck it
      // with the live clock without regenerating the classification already published.
      const checkedAt = memoryDate(this.clock());
      const checkedAuthority = requireMemoryCandidateAuthority(this.authority.db,
        { input, identity: memoryCandidateIdentity(input), now: checkedAt });
      const checked = computeMemoryCandidate(this.policy, input, { now: checkedAt, authority: checkedAuthority });
      if (checkedAt < now || checked.classification.state !== "awaiting_confirmation"
        || checkedAt.getTime() >= Date.parse(computation.classification.confirmation_expires_at!)
        || checkedAt.getTime() >= Date.parse(computation.classification.candidate_expires_at)) {
        return memoryFail("MEMORY_CANDIDATE_AUTHORITY_INVALID");
      }
    }
    this.insertCandidate(computation, input, authority, publication);
    return computation.classification;
  }

  private insertIdempotency(input: IdempotencyInsert): void {
    this.authority.db.prepare(
      `INSERT INTO memory_candidate_idempotency(idempotency_digest,request_digest,input_digest,candidate_id,created_at)
       VALUES(?,?,?,?,?)`,
    ).run(input.computation.idempotency_digest, input.computation.request_digest, input.computation.input_digest,
      input.candidate_id, input.created_at);
  }

  private insertCandidate(
    computation: MemoryCandidateComputation,
    input: ParsedMemoryCandidateInput,
    authority: MemoryAuthorityResolution,
    publication?: MemoryCandidateReviewPublication,
  ): void {
    const result = computation.classification;
    this.authority.db.prepare(
      `INSERT INTO memory_candidates(
        candidate_id,correlation_id,idempotency_key,candidate_kind,operation,subject_digest,content_digest,
        source_digest,sensitivity,purpose,required_confirmation,state,confirmation_expires_at,expires_at,created_at,updated_at
       ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(result.candidate_id, result.correlation_id, computation.idempotency_digest, result.candidate_kind,
      result.operation, result.subject_digest, result.content_digest, result.source_digest, result.storage_sensitivity,
      result.purpose, result.required_confirmation ? 1 : 0, "proposed", result.confirmation_expires_at,
      result.candidate_expires_at, result.created_at, result.created_at);
    this.insertClassification(computation);
    this.insertReferences(result);
    if (publication !== undefined) {
      this.authority.db.prepare(
        `INSERT OR IGNORE INTO memory_candidate_review_publications(
          candidate_id,candidate_digest,classification_digest,subject_digest,content_digest,
          content_bytes,review_spool_digest,expires_at,published_at
        ) VALUES(?,?,?,?,?,?,?,?,?)`,
      ).run(result.candidate_id, result.candidate_digest, result.classification_digest,
        result.subject_digest, result.content_digest, publication.content_bytes,
        publication.review_spool_digest, publication.expires_at, result.created_at);
    }
    claimMemoryCandidateAuthority(this.authority.db, authority, result);
    this.insertIdempotency({ computation, candidate_id: result.candidate_id, created_at: result.created_at });
    this.insertAudit(result, input.principal_id);
    if (result.state === "rejected" || result.state === "expired") {
      this.authority.db.prepare("UPDATE memory_candidates SET state=?,updated_at=? WHERE candidate_id=?")
        .run(result.state, result.created_at, result.candidate_id);
      return;
    }
    this.authority.db.prepare("UPDATE memory_candidates SET state='classified',updated_at=? WHERE candidate_id=?")
      .run(result.created_at, result.candidate_id);
    if (result.state !== "classified") {
      this.authority.db.prepare("UPDATE memory_candidates SET state=?,updated_at=? WHERE candidate_id=?")
        .run(result.state, result.created_at, result.candidate_id);
    }
  }

  private insertClassification(computation: MemoryCandidateComputation): void {
    const result = computation.classification;
    const source = result.source;
    this.authority.db.prepare(
      `INSERT INTO memory_candidate_classifications(
        candidate_id,schema_version,input_digest,identity_source_digest,candidate_digest,input_class,confidence,policy_sensitivity,
        retention_days,confirmation_gate,policy_digest,classification_reason,classification_digest,dedup_key,source_id,source_version,
        owner_principal,authenticated_session_digest,worker_id,worker_session_digest,verifier_id,instruction_id,outcome_id,
        attempt_id,verification_evidence_id,control_request_id,control_receipt_id,control_command_digest,authority_key_id,
        authority_expires_at,inference_id,inference_label,conflict_state,delivery_state,delivery_reason,created_at
       ) VALUES(${Array.from({ length: 36 }, () => "?").join(",")})`,
    ).run(
      result.candidate_id, result.schema_version, computation.input_digest, computation.source_identity_digest,
      result.candidate_digest, result.input_class,
      result.confidence, result.policy_sensitivity, result.retention_days, result.confirmation_gate, result.policy_digest,
      result.classification_reason, result.classification_digest, result.dedup_key, source.source_id, source.source_version,
      source.principal_id, source.authenticated_session_digest, source.worker_id, source.worker_session_digest,
      source.verifier_id, source.instruction_id, source.outcome_id, source.attempt_id, source.verification_evidence_id,
      source.request_id, source.receipt_id, source.command_digest, source.authority_key_id, source.authority_expires_at,
      source.inference_id, source.inference_label, result.conflict_state, result.delivery.state, result.delivery.reason,
      result.created_at,
    );
  }

  private insertReferences(result: MemoryCandidateClassification): void {
    const insert = this.authority.db.prepare(
      `INSERT INTO memory_candidate_source_refs(
        candidate_id,position,ref_kind,ref_namespace,ref_id,ref_version,evidence_digest,observed_at,fresh_until,expires_at
       ) VALUES(?,?,?,?,?,?,?,?,?,?)`,
    );
    for (const reference of result.source_refs) insert.run(
      result.candidate_id, reference.position, reference.kind, reference.identifier.namespace, reference.identifier.id,
      reference.identifier.version, reference.evidence_digest, reference.observed_at, reference.fresh_until,
      reference.expires_at,
    );
  }

  private insertAudit(result: MemoryCandidateClassification, principalId: string): void {
    const eventDigest = memoryHash(MEMORY_CANDIDATE_DIGEST_DOMAINS.audit, {
      candidate_id: result.candidate_id, classification_digest: result.classification_digest, state: result.state,
    });
    this.authority.db.prepare(
      `INSERT INTO personal_operation_audit_events(
        event_id,event_type,subject_kind,subject_id,principal_id,correlation_id,causation_id,event_digest,created_at
       ) VALUES(?,?,?,?,?,?,?,?,?)`,
    ).run(`event:memory:${eventDigest.slice(7)}`, `memory.candidate.${result.state}`, "memory_candidate",
      result.candidate_id, principalId, result.correlation_id, result.source.request_id ?? result.source.verification_evidence_id,
      eventDigest, result.created_at);
  }
}
