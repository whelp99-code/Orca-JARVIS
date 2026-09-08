import { JarvisError, type AuthorityDb } from "./db.js";
import { canonicalize } from "./canonical.js";
import { parseMemoryCandidateInput } from "./memory-candidate-input.js";
import { parseMemoryCandidatePolicy } from "./memory-candidate-policy.js";
import { memoryCandidateIdentity, computeMemoryCandidate } from "./memory-candidate-material.js";
import { requireMemoryCandidateAuthority } from "./memory-candidate-authority.js";
import { readMemoryCandidate } from "./memory-candidate-reader.js";
import { MemoryProjectionAuthority } from "./memory-projection-authority.js";
import { createMemoryCandidateReviewEnvelope, MemoryCandidateReviewSpool } from "./memory-candidate-review-spool.js";
import { MemoryCandidateDispatchSpool } from "./memory-candidate-dispatch-spool.js";
import type { MemoryOutboxSpoolRoots } from "./memory-outbox-values.js";

/** Publish already-approved remember material, never approve or enqueue it.
 * Stable candidate creation time lets retries adopt files left before DB commit. */
export function publishAutomaticMemoryCandidate(authority: AuthorityDb, inputValue: unknown, policyValue: unknown,
  roots: Required<MemoryOutboxSpoolRoots>, clock: () => Date) {
  const input = parseMemoryCandidateInput(inputValue); const policy = parseMemoryCandidatePolicy(policyValue);
  return authority.db.transaction(() => {
    const candidate = readMemoryCandidate(authority.db, memoryCandidateIdentity(input).candidate_id);
    if (candidate === undefined || candidate.state !== "approved" || candidate.required_confirmation
      || candidate.operation !== "remember") return undefined;
    const now = clock();
    const check = (at: Date) => {
      if (!Number.isFinite(at.getTime()) || at < now || at.getTime() >= Date.parse(candidate.candidate_expires_at)
        || new MemoryProjectionAuthority(authority).isProjectionIdSuppressed(candidate.candidate_id)) {
        throw new JarvisError("MEMORY_AUTO_PUBLICATION_INVALID");
      }
      return requireMemoryCandidateAuthority(authority.db, { input, identity: memoryCandidateIdentity(input), now: at });
    };
    const resolved = check(now);
    const computation = computeMemoryCandidate(policy, input, { now: new Date(candidate.created_at), authority: resolved });
    if (canonicalize(computation.classification) !== canonicalize(candidate)) throw new JarvisError("MEMORY_AUTO_PUBLICATION_INVALID");
    const review = createMemoryCandidateReviewEnvelope({ input, computation, classification: candidate });
    const reviewPublication = new MemoryCandidateReviewSpool(roots.candidate_review_spool_root).publish(review);
    const source = candidate.source;
    const receiptId = source.receipt_id ?? source.verification_evidence_id;
    if (receiptId === null || source.authority_expires_at === null) throw new JarvisError("MEMORY_AUTO_PUBLICATION_INVALID");
    const dispatch = new MemoryCandidateDispatchSpool(roots.candidate_dispatch_spool_root).publish(review, {
      decision: "auto_staged", control_request_id: source.request_id ?? receiptId, control_receipt_id: receiptId,
      command_digest: source.command_digest ?? candidate.source_digest, principal_id: "principal:owner",
      issued_at: candidate.created_at, expires_at: source.authority_expires_at,
    });
    check(clock());
    authority.db.prepare(`INSERT OR IGNORE INTO memory_candidate_review_publications(candidate_id,candidate_digest,
      classification_digest,subject_digest,content_digest,content_bytes,review_spool_digest,expires_at,published_at)
      VALUES(?,?,?,?,?,?,?,?,?)`).run(candidate.candidate_id, candidate.candidate_digest, candidate.classification_digest,
        candidate.subject_digest, candidate.content_digest, reviewPublication.content_bytes, reviewPublication.review_spool_digest,
        reviewPublication.expires_at, candidate.created_at);
    authority.db.prepare(`INSERT OR IGNORE INTO memory_candidate_dispatch_publications(candidate_id,schema_version,operation,
      dispatch_spool_digest,state,published_at) VALUES(?,?,?,?,'published',?)`).run(candidate.candidate_id,
        dispatch.schema_version, dispatch.operation, dispatch.dispatch_spool_digest, candidate.created_at);
    const row = authority.db.prepare(`SELECT r.review_spool_digest,d.dispatch_spool_digest FROM memory_candidate_review_publications r
      JOIN memory_candidate_dispatch_publications d ON d.candidate_id=r.candidate_id WHERE r.candidate_id=?`)
      .get(candidate.candidate_id) as { review_spool_digest: string; dispatch_spool_digest: string } | undefined;
    if (row?.review_spool_digest !== reviewPublication.review_spool_digest || row.dispatch_spool_digest !== dispatch.dispatch_spool_digest) {
      throw new JarvisError("MEMORY_AUTO_PUBLICATION_INVALID");
    }
    return dispatch;
  }).immediate();
}
