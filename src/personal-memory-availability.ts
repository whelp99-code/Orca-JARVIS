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
/**
 * Recommendations whose cited context carries a derived memory whose task is closed now.
 *
 * The same question the morning source asks of a context, asked of a recommendation, so that every
 * reader of one - the projection, the dashboard and the published brief alike - can answer it the
 * same way instead of each deciding for itself what a closed memory means.
 */
export function recommendationsWithClosedMemorySource(
  authority: AuthorityDb, recommendationIds: readonly string[],
): ReadonlySet<string> {
  const select = authority.db.prepare(
    "SELECT context_id FROM personal_recommendations WHERE recommendation_id=?");
  const byContext = new Map<string, string[]>();
  for (const id of new Set(recommendationIds)) {
    const value = select.pluck().get(id);
    if (value === undefined) continue;
    const contextId = persistenceText(value);
    byContext.set(contextId, [...byContext.get(contextId) ?? [], id]);
  }
  const closed = contextsWithClosedMemorySource(authority, [...byContext.keys()]);
  return new Set([...closed].flatMap(contextId => byContext.get(contextId) ?? []));
}

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
