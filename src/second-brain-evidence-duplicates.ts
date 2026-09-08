import type { SecondBrainEvidence, SecondBrainConflict } from "./second-brain-adapter-types.js";
type DuplicateResolution =
  | { readonly kind: "current" | "stale"; readonly evidence: readonly SecondBrainEvidence[] }
  | { readonly kind: "conflicts"; readonly conflicts: readonly SecondBrainConflict[] };

export function resolveDuplicates(rows: readonly SecondBrainEvidence[]): DuplicateResolution {
  const unique = new Map<string, SecondBrainEvidence>();
  for (const row of rows) {
    const key = row.record === null ? `legacy:${row.page_id}\0${row.sid}`
      : `record:${row.record.record_id}\0${row.record.record_digest}`;
    const prior = unique.get(key);
    if (prior !== undefined && prior.content_digest !== row.content_digest) {
      return {
        kind: "conflicts",
        conflicts: [{ conflict_id: `duplicate:${row.page_id}:${row.sid}`, page_id: row.page_id, state: "unresolved", left: prior, right: row }],
      };
    }
    unique.set(key, row);
  }
  const sorted = [...unique.values()].sort((left, right) => left.page_id.localeCompare(right.page_id)
    || left.sid.localeCompare(right.sid) || left.content_digest.localeCompare(right.content_digest));
  const stale = sorted.some(row => row.freshness.state === "stale");
  return { kind: stale ? "stale" : "current", evidence: sorted };
}
