import type {
  SecondBrainAdapterBudgets,
  SecondBrainEvidence,
  SecondBrainReadOutcome,
} from "./second-brain-adapter-types.js";
import { secondBrainUtf8Bytes } from "./second-brain-read-budget.js";

export type SecondBrainSearchRow = {
  readonly page_id: string;
  readonly section: string;
  readonly snippet: string;
  readonly score: number;
};
export type SecondBrainConflictRow = {
  readonly conflict_id: string;
  readonly page_id: string;
  readonly summary: string;
};

export function isSecondBrainRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function hasExactSecondBrainKeys(
  value: Readonly<Record<string, unknown>>,
  keys: readonly string[],
): boolean {
  const observed = Object.keys(value);
  return observed.length === keys.length && observed.every(key => keys.includes(key));
}

export function isSecondBrainPageId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256
    && !value.startsWith("/") && !value.includes("..") && !value.includes("\0");
}

export function parseSecondBrainSearchRows(
  value: readonly unknown[],
  budgets: SecondBrainAdapterBudgets,
): readonly SecondBrainSearchRow[] | undefined {
  const rows: SecondBrainSearchRow[] = [];
  for (const candidate of value) {
    if (!isSecondBrainRecord(candidate)
      || !hasExactSecondBrainKeys(candidate, ["page_id", "score", "section", "snippet"])
      || !isSecondBrainPageId(candidate["page_id"])
      || typeof candidate["section"] !== "string"
      || secondBrainUtf8Bytes(candidate["section"]) > budgets.max_excerpt_bytes
      || typeof candidate["snippet"] !== "string"
      || secondBrainUtf8Bytes(candidate["snippet"]) > budgets.max_excerpt_bytes
      || typeof candidate["score"] !== "number"
      || !Number.isFinite(candidate["score"])) return undefined;
    rows.push({
      page_id: candidate["page_id"],
      section: candidate["section"],
      snippet: candidate["snippet"],
      score: candidate["score"],
    });
  }
  return rows;
}

export function combineSecondBrainEvidence(
  rows: readonly SecondBrainEvidence[],
  checkedAt: Date,
): SecondBrainReadOutcome {
  const unique = new Map<string, SecondBrainEvidence>();
  for (const row of rows) {
    const key = `${row.page_id}\0${row.sid}`;
    const prior = unique.get(key);
    if (prior !== undefined && prior.content_digest !== row.content_digest) {
      return {
        kind: "conflicts",
        checked_at: checkedAt.toISOString(),
        conflicts: [{
          conflict_id: `duplicate:${row.page_id}:${row.sid}`,
          page_id: row.page_id,
          state: "unresolved",
          left: prior,
          right: row,
        }],
      };
    }
    unique.set(key, row);
  }
  const evidence = [...unique.values()].sort((left, right) => left.page_id.localeCompare(right.page_id)
    || left.sid.localeCompare(right.sid) || left.content_digest.localeCompare(right.content_digest));
  if (evidence.some(row => row.freshness.state === "stale")) {
    return {
      kind: "stale",
      code: "SECOND_BRAIN_EVIDENCE_STALE",
      checked_at: checkedAt.toISOString(),
      evidence,
    };
  }
  return { kind: "current", checked_at: checkedAt.toISOString(), evidence };
}

export function parseSecondBrainConflictRows(
  value: readonly unknown[],
  budgets: SecondBrainAdapterBudgets,
): readonly SecondBrainConflictRow[] | undefined {
  const rows: SecondBrainConflictRow[] = [];
  for (const candidate of value) {
    if (!isSecondBrainRecord(candidate)
      || !hasExactSecondBrainKeys(candidate, ["conflict_id", "page_id", "summary"])
      || !isSecondBrainPageId(candidate["conflict_id"])
      || !isSecondBrainPageId(candidate["page_id"])
      || typeof candidate["summary"] !== "string"
      || secondBrainUtf8Bytes(candidate["summary"]) > budgets.max_excerpt_bytes) return undefined;
    rows.push({
      conflict_id: candidate["conflict_id"],
      page_id: candidate["page_id"],
      summary: candidate["summary"],
    });
  }
  return rows;
}
