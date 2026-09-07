import type { MemoryAuthorityResolution } from "./memory-candidate-authority-types.js";
import { computeMemoryCandidate } from "./memory-candidate-material.js";
import type { ParsedMemoryCandidatePolicy } from "./memory-candidate-policy.js";
import { createMemoryCandidateReviewEnvelope, type MemoryCandidateReviewSpool } from "./memory-candidate-review-spool.js";
import type { MemoryCandidateComputation, ParsedMemoryCandidateInput } from "./memory-candidate-types.js";
import { memoryFail } from "./memory-candidate-values.js";

/** Called under the writer transaction only after proving no durable candidate exists.
 * Adopt exact uncommitted bytes; never overwrite a prior review or extend its lifetime. */
export function recoverUncommittedCandidateReview(spool: MemoryCandidateReviewSpool,
  policy: ParsedMemoryCandidatePolicy, input: ParsedMemoryCandidateInput, authority: MemoryAuthorityResolution,
  current: MemoryCandidateComputation, now: Date): MemoryCandidateComputation {
  let review;
  try { review = spool.read(current.classification.candidate_id); }
  catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return current;
    throw error;
  }
  const created = new Date(review.created_at);
  if (!Number.isFinite(created.getTime()) || created > now
    || Date.parse(review.confirmation_expires_at) <= now.getTime()
    || Date.parse(review.candidate_expires_at) <= now.getTime()) return memoryFail("MEMORY_CANDIDATE_REPLAY_CONFLICT");
  const original = computeMemoryCandidate(policy, input, { now: created, authority });
  if (original.classification.state !== "awaiting_confirmation"
    || createMemoryCandidateReviewEnvelope({ input, computation: original, classification: original.classification })
      .review_envelope_digest !== review.review_envelope_digest) return memoryFail("MEMORY_CANDIDATE_REPLAY_CONFLICT");
  return original;
}
