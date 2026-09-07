import { JarvisError } from "./db.js";
import {
  MemoryCandidateDispatchSpool,
  memoryCandidateWriteReceipt,
} from "./memory-candidate-dispatch-spool.js";
import { MemoryCandidateReviewSpool } from "./memory-candidate-review-spool.js";
import { parseSecondBrainWriteRequest } from "./second-brain-write-request.js";
import type { SecondBrainRememberWriteRequest } from "./second-brain-adapter-types.js";

/** Rebuilds a provider write request from the private candidate spools, so the
 *  control command carries only digests and never request content. */
export type SpooledDispatchInput = {
  readonly candidate_id: string;
  readonly dispatch_spool_digest: string;
  readonly roots: { readonly dispatch?: string; readonly review?: string };
  readonly now: Date;
};

export function resolveSpooledDispatch(input: SpooledDispatchInput): SecondBrainRememberWriteRequest {
  const dispatchRoot = input.roots.dispatch ?? process.env["JARVIS_MEMORY_DISPATCH_SPOOL_ROOT"];
  const reviewRoot = input.roots.review ?? process.env["JARVIS_MEMORY_REVIEW_SPOOL_ROOT"];
  if (dispatchRoot === undefined || reviewRoot === undefined) {
    throw new JarvisError("MEMORY_OUTBOX_AUTHORITY_INVALID");
  }
  const dispatch = new MemoryCandidateDispatchSpool(dispatchRoot).read(input.candidate_id);
  const review = new MemoryCandidateReviewSpool(reviewRoot).read(input.candidate_id);
  const request = parseSecondBrainWriteRequest({
    schema_version: dispatch.schema_version === 3 ? 3 : 1,
    ...(dispatch.schema_version === 3 ? { body_profile: dispatch.body_profile } : {}),
    candidate_id: dispatch.candidate_id,
    candidate_digest: dispatch.candidate_digest, classification_digest: dispatch.classification_digest,
    idempotency_key: dispatch.idempotency_key, operation: dispatch.operation, subject: review.subject,
    purpose: dispatch.purpose, sensitivity: dispatch.sensitivity, retention_days: dispatch.retention_days,
    created_at: dispatch.created_at, expires_at: dispatch.expires_at,
    expected_prior: dispatch.operation === "correct" ? dispatch.expected_prior : null,
    receipt: memoryCandidateWriteReceipt(dispatch), receipt_digest: dispatch.receipt_digest,
    payload: { content: review.statement },
    request_id: dispatch.request_id, request_digest: dispatch.request_digest,
  }, input.now);
  if ((dispatch.schema_version === 3) !== (review.schema_version === 2) || request === undefined
    || dispatch.dispatch_spool_digest !== input.dispatch_spool_digest
    || dispatch.review_spool_digest !== review.review_envelope_digest) {
    throw new JarvisError("MEMORY_OUTBOX_AUTHORITY_INVALID");
  }
  return request;
}
