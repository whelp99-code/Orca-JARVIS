import type { AuthorityDb } from "../db.js";
import { JarvisError } from "../db.js";
import { readExistingCandidateReview } from "../memory-candidate-review-spool.js";
import { MEMORY_CANDIDATE_DIGEST_DOMAINS } from "../memory-candidate-types.js";
import { memoryHash } from "../memory-candidate-values.js";
import { privateSensitivity } from "./memory-read-projection.js";
import { MemoryProjectionAuthority } from "../memory-projection-authority.js";
import { containsMemorySecret, containsMemoryPromptText } from "../memory-candidate-private.js";

/** Owner-only detail: never return private spool paths, credentials or unbound text. */
export function readCandidateReview(authority: AuthorityDb, root: string | undefined,
  candidateId: string, now: Date) {
  if (new MemoryProjectionAuthority(authority).isProjectionIdSuppressed(candidateId)) return undefined;
  const row = authority.db.prepare(
    `SELECT c.state,c.operation,c.sensitivity,c.expires_at,c.confirmation_expires_at,
      c.content_digest,c.subject_digest,c.purpose,m.candidate_digest,m.classification_digest,
      m.policy_digest,m.policy_sensitivity,m.retention_days,m.source_id,m.source_version,p.review_spool_digest
     FROM memory_candidates c JOIN memory_candidate_classifications m ON m.candidate_id=c.candidate_id
     LEFT JOIN memory_candidate_review_publications p ON p.candidate_id=c.candidate_id
     WHERE c.candidate_id=?`,
  ).get(candidateId) as Record<string, unknown> | undefined;
  if (row === undefined) return undefined;
  if (row["state"] !== "awaiting_confirmation") throw new JarvisError("MEMORY_STATE_CONFLICT");
  if (!(Date.parse(String(row["expires_at"])) > now.getTime())
    || !(Date.parse(String(row["confirmation_expires_at"])) > now.getTime())) {
    throw new JarvisError("MEMORY_CANDIDATE_EXPIRED");
  }
  if (root === undefined || privateSensitivity(String(row["sensitivity"]))) {
    throw new JarvisError("MEMORY_REVIEW_UNAVAILABLE");
  }
  try {
    const review = readExistingCandidateReview(root, candidateId);
    const fields = ["candidate_digest", "classification_digest", "content_digest", "subject_digest",
      "operation", "purpose", "policy_digest", "retention_days", "source_id", "source_version"] as const;
    if (review.candidate_id !== candidateId || fields.some(field => review[field] !== row[field])
      || review.sensitivity !== row["policy_sensitivity"]
      || [review.subject, review.statement, review.source_id, review.source_version]
        .some(value => containsMemorySecret(value) || containsMemoryPromptText(value))
      || review.review_envelope_digest !== row["review_spool_digest"]
      || memoryHash(MEMORY_CANDIDATE_DIGEST_DOMAINS.content, review.statement) !== review.content_digest
      || memoryHash(MEMORY_CANDIDATE_DIGEST_DOMAINS.subject, review.subject) !== review.subject_digest
      || !(Date.parse(review.confirmation_expires_at) > now.getTime())
      || !(Date.parse(review.candidate_expires_at) > now.getTime())) {
      throw new JarvisError("MEMORY_REVIEW_UNAVAILABLE");
    }
    return { schema_version: 1 as const, resource: "memory-candidate-review" as const,
      candidate_id: candidateId, operation: review.operation, review_digest: review.review_envelope_digest,
      subject: review.subject, statement: review.statement, source_id: review.source_id,
      source_version: review.source_version, sensitivity: review.sensitivity,
      retention_days: review.retention_days,
      expires_at: new Date(Math.min(Date.parse(review.confirmation_expires_at),
        Date.parse(review.candidate_expires_at), Date.parse(String(row["expires_at"])),
        Date.parse(String(row["confirmation_expires_at"])))).toISOString() };
  } catch {
    throw new JarvisError("MEMORY_REVIEW_UNAVAILABLE");
  }
}
