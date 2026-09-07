import { basename } from "node:path";
import type { AuthorityDb } from "./db.js";
import { MemoryCandidateReviewSpool } from "./memory-candidate-review-spool.js";

/** Remove source bytes only after committed terminal state; never inside caller transactions. */
export function cleanupMemoryCandidateReviews(authority: AuthorityDb, root: string): number {
  if (authority.db.inTransaction) throw new Error("MEMORY_REVIEW_CLEANUP_TRANSACTION_ACTIVE");
  const spool = new MemoryCandidateReviewSpool(root);
  let removed = 0;
  for (const path of spool.paths()) {
    const name = basename(path);
    if (!/^memcand_pos_v1_[0-9a-f]{64}\.json$/.test(name)) continue;
    const candidateId = `memcand:pos:v1:${name.slice(15, -5)}`;
    removed += authority.db.transaction(() => {
      const row = authority.db.prepare(
        `SELECT c.state,c.content_digest,c.subject_digest,m.candidate_digest,m.classification_digest,
           p.review_spool_digest,o.state AS outbox_state
         FROM memory_candidates c JOIN memory_candidate_classifications m ON m.candidate_id=c.candidate_id
         LEFT JOIN memory_candidate_review_publications p ON p.candidate_id=c.candidate_id
         LEFT JOIN memory_outbox o ON o.candidate_id=c.candidate_id WHERE c.candidate_id=?`,
      ).get(candidateId) as { state: string; content_digest: string; subject_digest: string;
        candidate_digest: string; classification_digest: string; review_spool_digest: string | null;
        outbox_state: string | null } | undefined;
      if (row === undefined || (row.outbox_state !== null
        && ["queued", "claimed", "dispatching", "reconciling"].includes(row.outbox_state))) return 0;
      if (!["rejected", "expired", "settled"].includes(row.state)
        && !["settled", "conflict", "failed", "expired"].includes(row.outbox_state ?? "")) return 0;
      try {
        const review = spool.read(candidateId);
        if (review.candidate_digest !== row.candidate_digest || review.classification_digest !== row.classification_digest
          || review.content_digest !== row.content_digest || review.subject_digest !== row.subject_digest
          || (row.review_spool_digest !== null && row.review_spool_digest !== review.review_envelope_digest)) {
          throw new Error("MEMORY_REVIEW_CLEANUP_INTEGRITY_FAILURE");
        }
        spool.remove({ candidate_id: candidateId, path, review_spool_digest: review.review_envelope_digest,
          content_bytes: Buffer.byteLength(review.statement), expires_at: review.confirmation_expires_at, created: false });
        return 1;
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return 0;
        throw error;
      }
    }).immediate();
  }
  return removed;
}
