import {
  SECOND_BRAIN_SOURCE_ID,
  SECOND_BRAIN_TRUST,
  type SecondBrainAdapterBudgets,
  type SecondBrainEvidence,
  type SecondBrainGenerationBinding,
  type SecondBrainReadOutcome,
  type SecondBrainSensitivity,
} from "./second-brain-adapter-types.js";
import { secondBrainUtf8Bytes, type SecondBrainReadBudget } from "./second-brain-read-budget.js";

export type SecondBrainSearchRow = {
  readonly page_id: string;
  readonly section: string;
  readonly snippet: string;
  readonly score: number;
  readonly record_id: string | null;
  readonly record_digest: string | null;
};
export type BoundRecordProjection = {
  readonly recordId: string; readonly recordDigest: string; readonly sid: string;
  readonly text: string; readonly textDigest: string; readonly source: string; readonly content: string;
  readonly citation: string; readonly owner: "provider_owned" | "external_read_only";
  readonly ownerDigest: string; readonly origin: string; readonly validFrom: string;
  readonly validUntil: string; readonly tier: SecondBrainSensitivity; readonly version: string;
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
    if (!isSecondBrainRecord(candidate)) return undefined;
    const bound = Object.hasOwn(candidate, "record_id") || Object.hasOwn(candidate, "record_digest");
    const keys = bound ? ["page_id", "record_digest", "record_id", "score", "section", "snippet"]
      : ["page_id", "score", "section", "snippet"];
    if (!hasExactSecondBrainKeys(candidate, keys)
      || !isSecondBrainPageId(candidate["page_id"])
      || typeof candidate["section"] !== "string"
      || secondBrainUtf8Bytes(candidate["section"]) > budgets.max_excerpt_bytes
      || typeof candidate["snippet"] !== "string"
      || secondBrainUtf8Bytes(candidate["snippet"]) > budgets.max_excerpt_bytes
      || typeof candidate["score"] !== "number" || !Number.isFinite(candidate["score"])
      || (bound && (typeof candidate["record_id"] !== "string"
        || !/^sbrecord:v1:[0-9a-f]{64}$/.test(candidate["record_id"])
        || typeof candidate["record_digest"] !== "string"
        || !/^sha256:[0-9a-f]{64}$/.test(candidate["record_digest"])))) return undefined;
    rows.push({
      page_id: candidate["page_id"],
      section: candidate["section"],
      snippet: candidate["snippet"],
      score: candidate["score"],
      record_id: bound ? String(candidate["record_id"]) : null,
      record_digest: bound ? String(candidate["record_digest"]) : null,
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
    const key = row.record === null ? `legacy:${row.page_id}\0${row.sid}`
      : `record:${row.record.record_id}\0${row.record.record_digest}`;
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

export function boundSecondBrainEvidence(input: {
  readonly pageId: string; readonly checkedAt: Date; readonly maxAgeMs: number; readonly expiryMs: number;
  readonly generation: SecondBrainGenerationBinding; readonly row: BoundRecordProjection;
}): SecondBrainEvidence {
  const from = Date.parse(input.row.validFrom); const until = Date.parse(input.row.validUntil);
  const checked = input.checkedAt.getTime();
  const applicable = from <= checked && checked < until;
  // Freshness describes this provider read, not renewed verification of the assertion.
  const freshUntil = applicable ? Math.min(checked + input.maxAgeMs, until) : checked;
  const expiresAt = applicable ? Math.min(checked + input.expiryMs, until) : checked;
  const redacted = input.row.tier === "sensitive" || input.row.tier === "restricted";
  return { kind: "memory", page_id: input.pageId, sid: input.row.sid, source_ref: input.row.origin,
    source_id: SECOND_BRAIN_SOURCE_ID, source_version: input.row.version, sensitivity: input.row.tier,
    observed_at: input.checkedAt.toISOString(), valid_at: input.row.validFrom,
    freshness: { state: applicable ? "fresh" : "stale",
      checked_at: input.checkedAt.toISOString(), fresh_until: new Date(freshUntil).toISOString() },
    expires_at: new Date(expiresAt).toISOString(), trust: SECOND_BRAIN_TRUST, authority: "none",
    excerpt: redacted ? null : input.row.text, content_digest: input.row.textDigest,
    omission: redacted ? "policy_redacted" : null,
    record: { record_id: input.row.recordId, record_digest: input.row.recordDigest,
      source_identity_full: input.row.source, content_identity_full: input.row.content,
      citation_identity_full: input.row.citation, source_owner_class: input.row.owner,
      source_owner_id_digest: input.row.ownerDigest, origin_label: input.row.origin,
      generation: input.generation } };
}

export function boundSecondBrainOutcome(
  outcome: SecondBrainReadOutcome,
  checkedAt: Date,
  requestBudget: SecondBrainReadBudget,
): SecondBrainReadOutcome {
  if (outcome.kind !== "current" && outcome.kind !== "stale" && outcome.kind !== "conflicts") return outcome;
  const code = requestBudget.consumeReturned(outcome);
  return code === undefined ? outcome : { kind: "invalid", code, checked_at: checkedAt.toISOString() };
}

export function nonDataSecondBrainOutcome(
  outcome: { readonly kind: "no_data"; readonly reason: "empty_result" }
    | { readonly kind: "error"; readonly code: string },
  checkedAt: Date,
): SecondBrainReadOutcome {
  switch (outcome.kind) {
    case "no_data": return { kind: "no_data", checked_at: checkedAt.toISOString(),
      fresh_until: new Date(checkedAt.getTime() + 60_000).toISOString() };
    case "error": return { kind: "unavailable", code: outcome.code, checked_at: checkedAt.toISOString() };
    default: return assertNever(outcome);
  }
}

export function parseSecondBrainConflictRows(
  value: readonly unknown[],
  budgets: SecondBrainAdapterBudgets,
): readonly SecondBrainConflictRow[] | undefined {
  const rows: SecondBrainConflictRow[] = [];
  for (const candidate of value) {
    if (!isSecondBrainRecord(candidate)) return undefined;
    const bound = Object.hasOwn(candidate, "records");
    if (!hasExactSecondBrainKeys(candidate,
      bound ? ["conflict_id", "page_id", "records", "summary"] : ["conflict_id", "page_id", "summary"])
      || !isSecondBrainPageId(candidate["conflict_id"])
      || !isSecondBrainPageId(candidate["page_id"])
      || typeof candidate["summary"] !== "string"
      || secondBrainUtf8Bytes(candidate["summary"]) > budgets.max_excerpt_bytes
      || (bound && (!Array.isArray(candidate["records"]) || candidate["records"].length > 64))) return undefined;
    rows.push({
      conflict_id: candidate["conflict_id"],
      page_id: candidate["page_id"],
      summary: candidate["summary"],
    });
  }
  return rows;
}

function assertNever(value: never): never {
  throw new Error(`unexpected Second Brain outcome: ${JSON.stringify(value)}`);
}
