import type { AuthorityDb } from "../db.js";
import type { MemoryMembership } from "../memory-read-privacy.js";
import type { SecondBrainEvidence } from "../second-brain-adapter-types.js";
import type { MemoryRecordHistoryEntry } from "./memory-contracts.js";

export const MEMORY_HISTORY_LIMIT = 8;

/** What the authority knows about one provider record: owner decisions, receipts, and suppression. */
export type MemoryRecordLineage = {
  /** A forget suppression (surface or legacy) hides the record entirely. */
  readonly forgotten: boolean;
  /** Control request id of the approved correction that superseded this record, if any. */
  readonly superseded_by: string | null;
  readonly history: readonly MemoryRecordHistoryEntry[];
};

const CURRENT: MemoryRecordLineage = { forgotten: false, superseded_by: null, history: [] };
const TARGET_MATCH = `(t.record_membership_hmac IN (?,?,?,?) OR t.source_membership_hmac IN (?,?,?,?)
  OR t.content_membership_hmac IN (?,?,?,?) OR t.citation_membership_hmac IN (?,?,?,?))`;

type SuppressionRow = { readonly operation: "correct" | "forget"; readonly control_request_id: string;
  readonly control_receipt_id: string; readonly effective_at: string; readonly sequence: number };
type AttemptRow = { readonly operation: "correct" | "forget" | "export"; readonly state: string;
  readonly control_request_id: string; readonly updated_at: string };

export function memoryRecordLineage(
  authority: AuthorityDb, evidence: SecondBrainEvidence, membership: MemoryMembership,
): MemoryRecordLineage {
  const record = evidence.record;
  if (record === null) return CURRENT;
  const identities = [
    membership("record", `${record.record_id}\0${record.record_digest}`),
    membership("source", record.source_identity_full),
    membership("content", record.content_identity_full),
    membership("citation", record.citation_identity_full),
  ] as const;
  const match = [...identities, ...identities, ...identities, ...identities];
  const suppressions = authority.db.prepare(
    `SELECT s.operation,s.control_request_id,s.control_receipt_id,s.effective_at,s.sequence
     FROM memory_surface_suppressions s
     JOIN memory_surface_target_versions t ON t.target_version_digest=s.target_version_digest
     WHERE ${TARGET_MATCH} ORDER BY s.sequence DESC LIMIT ?`,
  ).all(...match, MEMORY_HISTORY_LIMIT) as SuppressionRow[];
  const attempts = authority.db.prepare(
    `SELECT f.operation,a.state,a.control_request_id,a.updated_at
     FROM memory_surface_effect_attempts a
     JOIN memory_surface_semantic_families f ON f.family_digest=a.family_digest
     JOIN memory_surface_target_versions t ON t.target_version_digest=f.target_version_digest
     WHERE ${TARGET_MATCH} ORDER BY a.updated_at DESC,a.attempt_id LIMIT ?`,
  ).all(...match, MEMORY_HISTORY_LIMIT) as AttemptRow[];
  // Forgotten is an exact existence question, never bounded by the history window.
  const forgotten = authority.db.prepare(
    `SELECT 1 FROM memory_surface_suppressions s
     JOIN memory_surface_target_versions t ON t.target_version_digest=s.target_version_digest
     WHERE s.operation='forget' AND ${TARGET_MATCH} LIMIT 1`,
  ).get(...match);
  const legacy = authority.db.prepare(
    `SELECT 1 FROM memory_suppressions WHERE state='active' AND (
      target_digest IN (?,?) OR source_identity_digest IN (?,?)
      OR content_identity_digest IN (?,?) OR citation_identity_digest IN (?,?)) LIMIT 1`,
  ).get(record.record_digest, record.record_id, record.source_identity_full, identities[1],
    record.content_identity_full, identities[2], record.citation_identity_full, identities[3]);
  const history: MemoryRecordHistoryEntry[] = [
    ...suppressions.map(row => ({ operation: row.operation, state: "suppressed" as const,
      request_id: row.control_request_id, receipt_id: row.control_receipt_id, at: row.effective_at })),
    ...attempts.map(row => ({ operation: row.operation, state: row.state,
      request_id: row.control_request_id, receipt_id: null, at: row.updated_at })),
  ].sort((left, right) => right.at.localeCompare(left.at) || left.request_id.localeCompare(right.request_id))
    .slice(0, MEMORY_HISTORY_LIMIT);
  return {
    forgotten: forgotten !== undefined || legacy !== undefined,
    superseded_by: suppressions.find(row => row.operation === "correct")?.control_request_id ?? null,
    history,
  };
}
