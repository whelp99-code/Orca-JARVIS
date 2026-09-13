import type { AuthorityDb } from "./db.js";
import { derivedMemoryTaskClosed } from "./memory-candidate-task-source.js";
import { persistenceText } from "./personal-persistence-values.js";

/**
 * Contexts carrying a derived memory whose originating task is closed now.
 *
 * Hiding a task, or taking its project out of scope, already closes the candidate's review, its
 * owner decision and its write, and it closes citing the memory that task produced. A recommendation
 * built on one earlier is the surface that remained: the lineage is immutable and nothing here
 * rewrites it, but the reader stops offering it as current work.
 */
export function contextsWithClosedMemorySource(
  authority: AuthorityDb, contextIds: readonly string[],
): ReadonlySet<string> {
  const select = authority.db.prepare(
    "SELECT evidence_digest FROM personal_context_memory_evidence WHERE context_id=?");
  const closed = new Set<string>();
  for (const contextId of new Set(contextIds)) {
    for (const value of select.pluck().all(contextId)) {
      if (!derivedMemoryTaskClosed(authority, persistenceText(value))) continue;
      closed.add(contextId);
      break;
    }
  }
  return closed;
}
