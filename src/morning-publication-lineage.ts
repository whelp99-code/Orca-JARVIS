import type { AuthorityDb } from "./db.js";
import { canonicalize } from "./canonical.js";
import { MemoryProjectionAuthority } from "./memory-projection-authority.js";
import { isMemorySuppressed } from "./memory-suppression.js";
import type { MemoryProjectionDependency, MemoryProjectionRef } from "./memory-projection-types.js";
import type { MorningRecommendationLineage } from "./morning-recommendation-source.js";

export class MorningPublicationError extends Error {
  readonly name = "MorningPublicationError";
  constructor() { super("MORNING_PUBLICATION_REJECTED"); }
}
export function rejectMorningPublication(): never { throw new MorningPublicationError(); }

export function morningPublicationDependencies(authority: AuthorityDb, lineage: readonly MorningRecommendationLineage[]) {
  const projections = new MemoryProjectionAuthority(authority);
  const parents = new Map<string, MemoryProjectionRef>();
  for (const item of lineage) {
    const refs: MemoryProjectionRef[] = [
      { kind: "context", id: item.context_id, component_id: item.context_id },
      { kind: "recommendation", id: item.recommendation_id, component_id: item.recommendation_id },
      { kind: "recommendation_action", id: item.recommendation_id, component_id: String(item.rank) },
    ];
    for (const ref of refs) parents.set(canonicalize(ref), ref);
  }
  const dependencies = new Map<string, MemoryProjectionDependency>();
  const select = authority.db.prepare(`SELECT target_digest,keyed_subject_digest,source_identity_digest,
    content_identity_digest,citation_identity_digest,source_context_id FROM memory_projection_dependencies
    WHERE projection_kind=? AND projection_id=? AND component_id=? ORDER BY target_digest`);
  for (const ref of parents.values()) {
    if (projections.isSuppressed(ref)) return rejectMorningPublication();
    const rows = select.all(ref.kind, ref.id, ref.component_id) as Record<string, string | null>[];
    if (rows.length === 0) return rejectMorningPublication();
    for (const row of rows) {
      const dependency: MemoryProjectionDependency = Object.fromEntries(Object.entries(row).filter(([, value]) => value !== null));
      if (isMemorySuppressed(authority, dependency)) return rejectMorningPublication();
      dependencies.set(canonicalize(dependency), dependency);
    }
  }
  return [...dependencies.values()];
}

export function bindMorningPublication(authority: AuthorityDb, refs: readonly MemoryProjectionRef[],
  dependencies: readonly MemoryProjectionDependency[], at: Date): void {
  const projections = new MemoryProjectionAuthority(authority);
  for (const dependency of dependencies) if (isMemorySuppressed(authority, dependency)) return rejectMorningPublication();
  for (const ref of refs) {
    for (let offset = 0; offset < dependencies.length; offset += 64) projections.bind(ref, dependencies.slice(offset, offset + 64), at);
    if (projections.isSuppressed(ref)) return rejectMorningPublication();
    const stored = authority.db.prepare(`SELECT target_digest,keyed_subject_digest,source_identity_digest,
      content_identity_digest,citation_identity_digest,source_context_id FROM memory_projection_dependencies
      WHERE projection_kind=? AND projection_id=? AND component_id=?`).all(ref.kind, ref.id, ref.component_id) as
      Record<string, string | null>[];
    const identities = new Set(stored.map(row => canonicalize(Object.fromEntries(Object.entries(row).filter(([, value]) => value !== null)))));
    // The legacy target-only PK can ignore a different source identity for the same target.
    if (dependencies.some(dependency => !identities.has(canonicalize(dependency)))) return rejectMorningPublication();
  }
}
