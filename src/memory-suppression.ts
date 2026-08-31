import type { AuthorityDb } from "./db.js";

export type MemorySuppressionIdentity = {
  readonly target_digest?: string;
  readonly keyed_subject_digest?: string;
  readonly source_identity_digest?: string;
  readonly content_identity_digest?: string;
  readonly citation_identity_digest?: string;
};

export function isMemorySuppressed(
  authority: AuthorityDb,
  identity: MemorySuppressionIdentity,
): boolean {
  const values = [
    identity.target_digest,
    identity.keyed_subject_digest,
    identity.source_identity_digest,
    identity.content_identity_digest,
    identity.citation_identity_digest,
  ];
  if (values.every(value => value === undefined)) return false;
  const row = authority.db.prepare(
    `SELECT 1 FROM memory_suppressions WHERE state='active' AND (
      (? IS NOT NULL AND target_digest=?) OR
      (? IS NOT NULL AND keyed_subject_digest=?) OR
      (? IS NOT NULL AND source_identity_digest=?) OR
      (? IS NOT NULL AND content_identity_digest=?) OR
      (? IS NOT NULL AND citation_identity_digest=?)) LIMIT 1`,
  ).get(identity.target_digest ?? null, identity.target_digest ?? null,
    identity.keyed_subject_digest ?? null, identity.keyed_subject_digest ?? null,
    identity.source_identity_digest ?? null, identity.source_identity_digest ?? null,
    identity.content_identity_digest ?? null, identity.content_identity_digest ?? null,
    identity.citation_identity_digest ?? null, identity.citation_identity_digest ?? null);
  if (row !== undefined) return true;
  if (identity.keyed_subject_digest === undefined) return false;
  return authority.db.prepare(
    `SELECT 1 FROM memory_deletion_legacy_audit
     WHERE migrated_state='reconciling' AND prior_tombstone_digest IS NOT NULL
       AND subject_digest=? LIMIT 1`,
  ).get(identity.keyed_subject_digest) !== undefined;
}

export function suppressMemoryProjection<T>(
  authority: AuthorityDb,
  values: readonly T[],
  identity: (value: T) => MemorySuppressionIdentity,
): readonly T[] {
  return values.filter(value => !isMemorySuppressed(authority, identity(value)));
}

export function activeMemorySuppressionCount(authority: AuthorityDb): number {
  return Number((authority.db.prepare(
    "SELECT COUNT(*) AS count FROM memory_suppressions WHERE state='active'",
  ).get() as { readonly count: number }).count);
}
