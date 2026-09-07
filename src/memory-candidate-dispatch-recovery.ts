import type { AuthorityDb } from "./db.js";
import { MemoryCandidateDispatchSpool } from "./memory-candidate-dispatch-spool.js";
import type { MemoryCandidateReviewEnvelope } from "./memory-candidate-review-spool.js";

/** Called after the control receipt INSERT has acquired the SQLite writer lock,
 * before inserting the candidate decision. An outer rollback may leave a file
 * without authority; only such a file may be removed for a fresh publication. */
export function recoverMemoryCandidateDispatch(
  authority: AuthorityDb, root: string, review: MemoryCandidateReviewEnvelope,
): void {
  if (!authority.db.inTransaction) throw new Error("MEMORY_DISPATCH_RECOVERY_TRANSACTION_REQUIRED");
  const spool = new MemoryCandidateDispatchSpool(root);
  let prior;
  try { prior = spool.read(review.candidate_id); }
  catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
  // An existing receipt includes the current receipt on an identical retry.
  // Leave it to publish's exact digest comparison; never rewrite signed work.
  const durable = authority.db.prepare(
    `SELECT 1 FROM control_command_receipts WHERE receipt_id=?
     UNION ALL SELECT 1 FROM memory_candidate_owner_decisions WHERE candidate_id=?
     UNION ALL SELECT 1 FROM memory_candidate_dispatch_publications WHERE candidate_id=?
     UNION ALL SELECT 1 FROM memory_outbox WHERE candidate_id=? LIMIT 1`,
  ).get(prior.control_receipt_id, review.candidate_id, review.candidate_id, review.candidate_id);
  if (durable !== undefined) return;
  const candidate = authority.db.prepare("SELECT state FROM memory_candidates WHERE candidate_id=?")
    .get(review.candidate_id) as { state: string } | undefined;
  if (candidate?.state !== "awaiting_confirmation" || prior.decision !== "owner_confirmed"
    || prior.candidate_id !== review.candidate_id || prior.operation !== review.operation
    || prior.candidate_digest !== review.candidate_digest || prior.classification_digest !== review.classification_digest
    || prior.content_digest !== review.content_digest || prior.review_spool_digest !== review.review_envelope_digest) {
    throw new Error("MEMORY_DISPATCH_RECOVERY_CONFLICT");
  }
  spool.remove({ candidate_id: prior.candidate_id, path: spool.pathFor(prior.candidate_id),
    dispatch_spool_digest: prior.dispatch_spool_digest, operation: prior.operation,
    schema_version: prior.schema_version, created: false });
}
