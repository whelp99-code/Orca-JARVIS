import type { AuthorityDb } from "./db.js";
import { JarvisError } from "./db.js";
import { resolveSpooledDispatch } from "./memory-outbox-dispatch-request.js";
import type { MemoryOutboxSpoolRoots } from "./memory-outbox-values.js";
import { memoryRememberArtifact } from "./memory-remember-artifact.js";
import { hasSecondBrainWriteAuthority } from "./second-brain-write-authority.js";

/** Prepare a reviewable command from persisted authority; callers still stage/approve/claim it normally. */
export function prepareMemoryRememberDispatch(
  authority: AuthorityDb, candidateId: string, now: Date, roots: MemoryOutboxSpoolRoots = {},
) {
  const publication = authority.db.prepare(
    `SELECT dispatch_spool_digest FROM memory_candidate_dispatch_publications
     WHERE candidate_id=? AND operation='remember' AND state='published'`,
  ).get(candidateId) as { dispatch_spool_digest: string } | undefined;
  if (publication === undefined) throw new JarvisError("MEMORY_OUTBOX_AUTHORITY_INVALID");
  const request = resolveSpooledDispatch({ candidate_id: candidateId,
    dispatch_spool_digest: publication.dispatch_spool_digest, now,
    roots: { review: roots.candidate_review_spool_root, dispatch: roots.candidate_dispatch_spool_root } });
  if (!hasSecondBrainWriteAuthority(authority, request, now)) throw new JarvisError("MEMORY_OUTBOX_AUTHORITY_INVALID");
  return { action: "memory.outbox.dispatch", action_level: 3, reversible: false,
    target: { candidate_id: request.candidate_id, candidate_digest: request.candidate_digest,
      classification_digest: request.classification_digest },
    args: { schema_version: 2, dispatch_spool_digest: publication.dispatch_spool_digest,
      expected_artifact: memoryRememberArtifact(request).artifact } } as const;
}
