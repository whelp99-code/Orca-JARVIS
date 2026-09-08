import { join } from "node:path";
import { memoryDatabase, closeMemoryDatabase, seedMemoryAuthority, memoryCandidateStore } from "./memory-candidate-store.js";
import { verifiedMemoryInput, MEMORY_NOW } from "./memory-candidate-fixture.js";
import { MemoryCandidateReviewSpool, memoryCandidateReviewDigest, type MemoryCandidateReviewEnvelope } from "../../src/memory-candidate-review-spool.js";
import { MemoryCandidateDispatchSpool } from "../../src/memory-candidate-dispatch-spool.js";
import { providerWriteIdempotencyKey } from "../../src/memory-candidate-dispatch-receipts.js";
import { resolveSpooledDispatch } from "../../src/memory-outbox-dispatch-request.js";

export async function scopedV3DispatchFixture() {
  const database = await memoryDatabase();
  try {
    const now = new Date(MEMORY_NOW);
    const statement = "첫 결정\r\n두 번째 결정\n반복\n반복 [^user]";
    const input = { ...verifiedMemoryInput({ statement }), schema_version: 2, body_profile: "plain-text-v1" };
    seedMemoryAuthority(database.authority, input);
    const candidate = memoryCandidateStore(database.authority).classify(input);
    const core: MemoryCandidateReviewEnvelope = {
      schema_version: 2, body_profile: "plain-text-v1", candidate_id: candidate.candidate_id,
      candidate_digest: candidate.candidate_digest, classification_digest: candidate.classification_digest,
      subject_digest: candidate.subject_digest, content_digest: candidate.content_digest,
      operation: "remember", subject: "Task 27 verification", statement, purpose: candidate.purpose,
      sensitivity: candidate.policy_sensitivity, source_class: candidate.input_class,
      source_id: candidate.source.source_id, source_version: candidate.source.source_version,
      policy_digest: candidate.policy_digest, idempotency_key: providerWriteIdempotencyKey(candidate),
      request_id: `memreq:pos:v1:${"2".repeat(64)}`, request_digest: `sha256:${"2".repeat(64)}`,
      retention_days: candidate.retention_days, created_at: candidate.created_at,
      candidate_expires_at: candidate.candidate_expires_at, confirmation_expires_at: candidate.candidate_expires_at,
      review_envelope_digest: `sha256:${"0".repeat(64)}`,
    };
    const review = { ...core, review_envelope_digest: memoryCandidateReviewDigest(core) };
    const roots = { review: join(database.root, "review"), dispatch: join(database.root, "dispatch") };
    new MemoryCandidateReviewSpool(roots.review).publish(review);
    const publication = new MemoryCandidateDispatchSpool(roots.dispatch).publish(review, {
      control_request_id: "fixture-verification", control_receipt_id: candidate.source.verification_evidence_id!,
      command_digest: `sha256:${"4".repeat(64)}`, decision: "auto_staged", principal_id: "principal:owner",
      issued_at: candidate.created_at, expires_at: candidate.source.authority_expires_at!,
    });
    const dispatch = { dispatch_spool_digest: publication.dispatch_spool_digest, roots };
    const request = resolveSpooledDispatch({ ...dispatch, candidate_id: candidate.candidate_id, now });
    return { database, candidate, now, statement, request, dispatch };
  } catch (error) { closeMemoryDatabase(database); throw error; }
}
