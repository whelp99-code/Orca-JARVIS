import { JarvisError, type AuthorityDb } from "./db.js";
import { readMemoryCandidate } from "./memory-candidate-reader.js";
import { readApprovedMemoryScopeReview } from "./memory-scope-review.js";
import { memoryHash } from "./memory-candidate-values.js";

/** Scope-bound identity for the forthcoming write contract. No receipt is consumed
 * and no write is granted; consumers must bind this identity atomically to dispatch. */
export function prepareMemoryScopedWriteIdentity(authority: AuthorityDb, proposal: unknown, requestId: string, now: Date) {
  return authority.db.transaction(() => {
  const review = readApprovedMemoryScopeReview(authority, proposal, requestId, now);
  const value = review.proposal;
  if (readMemoryCandidate(authority.db, value.candidate_id)?.operation !== "remember") {
    throw new JarvisError("SCOPED_WRITE_IDENTITY_INVALID");
  }
  const identity = Object.freeze({ schema_version: 1 as const, operation: "remember" as const,
    candidate_id: value.candidate_id, candidate_digest: value.candidate_digest,
    classification_digest: value.classification_digest, source_digest: value.source_digest,
    owner: value.scope.owner, projects: value.scope.projects,
    policy_revision: value.scope.policy_revision });
  // Proposal timestamps and approval receipt IDs are not idempotency inputs:
  // reapproval of the same candidate/scope must not create a duplicate write.
  const digest = memoryHash("orca-jarvis/memory-scoped-write-identity/v1\0", identity);
  return Object.freeze({ identity, identity_digest: digest,
    proposal_digest: value.proposal_digest,
    idempotency_key: `memidem:scoped:v1:${digest.slice(7)}`,
    control_request_id: review.control_request_id, control_receipt_id: review.control_receipt_id,
    command_digest: review.command_digest, expires_at: review.expires_at, writes_authorized: false as const });
  })();
}
