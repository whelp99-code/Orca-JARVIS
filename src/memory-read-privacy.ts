import { JarvisError, type AuthorityDb } from "./db.js";
import type { SecondBrainEvidence } from "./second-brain-adapter-types.js";
import { memoryReadHighWater } from "./memory-read-fence.js";
import { providerTombstoneSuppresses } from "./provider-tombstone-replica.js";

export type MemoryMembership = (kind: "source" | "content" | "citation" | "record", value: string) => string;
export type MemoryReadPrivacyState = {
  readonly privacy_epoch: number; readonly suppression_sequence: number;
  readonly suppression_root: string; readonly policy_digest: string | null;
  readonly tombstone_sequence: number; readonly tombstone_set_root: string;
  readonly membership_revision: string; readonly legacy_suppressions: number;
  readonly read_revision: number;
};

/** Read all policy components from one short snapshot, including for web callers. */
export function memoryReadPrivacyState(authority: AuthorityDb): MemoryReadPrivacyState {
  try { return authority.db.transaction(() => readPrivacyState(authority))(); }
  catch { throw new JarvisError("MEMORY_REFERENCE_PRIVACY_UNAVAILABLE"); }
}

function readPrivacyState(authority: AuthorityDb): MemoryReadPrivacyState {
  const surface = authority.db.prepare(
    "SELECT privacy_epoch,suppression_sequence,suppression_root,policy_digest FROM memory_surface_authority WHERE singleton_id=1",
  ).get() as Pick<MemoryReadPrivacyState, "privacy_epoch" | "suppression_sequence" | "suppression_root" | "policy_digest"> | undefined;
  if (surface === undefined) throw new Error("MEMORY_REFERENCE_PRIVACY_UNAVAILABLE");
  const tombstone = memoryReadHighWater(authority);
  const membership = authority.db.prepare(
    "SELECT COUNT(*) AS count,COALESCE(MAX(created_at),'') AS latest FROM memory_surface_target_versions",
  ).get() as { count: number; latest: string };
  const legacy = authority.db.prepare("SELECT COUNT(*) AS count FROM memory_suppressions").get() as { count: number };
  const revision = authority.db.prepare("SELECT revision FROM memory_read_revision WHERE singleton_id=1").get() as { revision: number } | undefined;
  if (revision === undefined || !Number.isSafeInteger(revision.revision) || revision.revision < 0) throw new Error();
  return { ...surface, tombstone_sequence: tombstone.sequence, tombstone_set_root: tombstone.set_root,
    membership_revision: `${String(membership.count)}:${membership.latest}`, legacy_suppressions: legacy.count,
    read_revision: revision.revision };
}

export function isMemoryReadSuppressed(
  authority: AuthorityDb, evidence: SecondBrainEvidence, membership: MemoryMembership,
): boolean {
    const record = evidence.record;
    if (record === null) return false;
    const recordMembership = membership("record", `${record.record_id}\0${record.record_digest}`);
    const sourceMembership = membership("source", record.source_identity_full);
    const contentMembership = membership("content", record.content_identity_full);
    const citationMembership = membership("citation", record.citation_identity_full);
    const surface = authority.db.prepare(
      `SELECT 1 FROM memory_surface_suppressions s
       JOIN memory_surface_target_versions t ON t.target_version_digest=s.target_version_digest
       WHERE t.record_membership_hmac IN (?,?,?,?)
          OR t.source_membership_hmac IN (?,?,?,?)
          OR t.content_membership_hmac IN (?,?,?,?)
          OR t.citation_membership_hmac IN (?,?,?,?) LIMIT 1`,
    ).get(recordMembership, sourceMembership, contentMembership, citationMembership,
      recordMembership, sourceMembership, contentMembership, citationMembership,
      recordMembership, sourceMembership, contentMembership, citationMembership,
      recordMembership, sourceMembership, contentMembership, citationMembership);
    if (surface !== undefined) return true;
    const legacy = authority.db.prepare(
      `SELECT 1 FROM memory_suppressions WHERE state='active' AND (
        target_digest IN (?,?) OR source_identity_digest IN (?,?)
        OR content_identity_digest IN (?,?) OR citation_identity_digest IN (?,?)) LIMIT 1`,
    ).get(record.record_digest, record.record_id, record.source_identity_full, sourceMembership,
      record.content_identity_full, contentMembership, record.citation_identity_full, citationMembership);
    if (legacy !== undefined) return true;
    return providerTombstoneSuppresses(authority, [
      record.record_digest, record.record_id, record.source_identity_full, record.content_identity_full,
      record.citation_identity_full,
    ]);
  }
