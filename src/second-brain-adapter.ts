import { parseSecondBrainPage } from "./second-brain-evidence-parser.js";
import {
  type SecondBrainAdapterOptions,
  type SecondBrainConflict,
  type SecondBrainEvidence,
  type SecondBrainReadAdapter,
  type SecondBrainReadOutcome,
} from "./second-brain-adapter-types.js";
import {
  SecondBrainTransportError,
  type SecondBrainOutcome,
  type SecondBrainReadMethod,
} from "./second-brain-transport.js";

export type {
  SecondBrainAdapterBudgets,
  SecondBrainAdapterOptions,
  SecondBrainConflict,
  SecondBrainEvidence,
  SecondBrainReadAdapter,
  SecondBrainReadOutcome,
  SecondBrainSensitivity,
} from "./second-brain-adapter-types.js";
export { SECOND_BRAIN_SENSITIVITIES, SECOND_BRAIN_SOURCE_ID, SECOND_BRAIN_TRUST } from "./second-brain-adapter-types.js";

const OFFLINE_CODES = [
  "SECOND_BRAIN_CHILD_EXIT",
  "SECOND_BRAIN_DISCOVERY_FAILED",
  "SECOND_BRAIN_START_FAILED",
] as const;
const CHECK_FRESH_MS = 60_000;

type CallResult =
  | { readonly kind: "transport"; readonly outcome: SecondBrainOutcome }
  | { readonly kind: "adapter"; readonly outcome: SecondBrainReadOutcome };

type SearchRow = {
  readonly page_id: string;
  readonly section: string;
  readonly snippet: string;
  readonly score: number;
};
type ConflictRow = { readonly conflict_id: string; readonly page_id: string; readonly summary: string };

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function exact(value: Readonly<Record<string, unknown>>, keys: readonly string[]): boolean {
  const observed = Object.keys(value);
  return observed.length === keys.length && observed.every(key => keys.includes(key));
}
function invalid(code: string, checkedAt: Date): SecondBrainReadOutcome {
  return { kind: "invalid", code, checked_at: checkedAt.toISOString() };
}
function validPageId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256
    && !value.startsWith("/") && !value.includes("..") && !value.includes("\0");
}
function combineEvidence(rows: readonly SecondBrainEvidence[], options: SecondBrainAdapterOptions, checkedAt: Date): SecondBrainReadOutcome {
  const unique = new Map<string, SecondBrainEvidence>();
  for (const row of rows) {
    const key = `${row.page_id}\0${row.sid}`;
    const prior = unique.get(key);
    if (prior !== undefined && prior.content_digest !== row.content_digest) {
      return {
        kind: "conflicts",
        checked_at: checkedAt.toISOString(),
        conflicts: [{ conflict_id: `duplicate:${row.page_id}:${row.sid}`, page_id: row.page_id, state: "unresolved", left: prior, right: row }],
      };
    }
    unique.set(key, row);
  }
  const evidence = [...unique.values()].sort((left, right) => left.page_id.localeCompare(right.page_id)
    || left.sid.localeCompare(right.sid) || left.content_digest.localeCompare(right.content_digest));
  const bytes = evidence.reduce((total, row) => total + Buffer.byteLength(row.excerpt ?? "", "utf8"), 0);
  if (bytes > options.budgets.max_total_bytes) return invalid("SECOND_BRAIN_AGGREGATE_OVERSIZE", checkedAt);
  if (evidence.some(row => row.freshness.state === "stale")) {
    return { kind: "stale", code: "SECOND_BRAIN_EVIDENCE_STALE", checked_at: checkedAt.toISOString(), evidence };
  }
  return { kind: "current", checked_at: checkedAt.toISOString(), evidence };
}

class BoundedSecondBrainReadAdapter implements SecondBrainReadAdapter {
  constructor(private readonly options: SecondBrainAdapterOptions) {
    const { budgets } = options;
    if (!Number.isSafeInteger(budgets.max_hits) || budgets.max_hits < 1 || budgets.max_hits > 32
      || !Number.isSafeInteger(budgets.max_excerpt_bytes) || budgets.max_excerpt_bytes < 1 || budgets.max_excerpt_bytes > 4_096
      || !Number.isSafeInteger(budgets.max_total_bytes) || budgets.max_total_bytes < budgets.max_excerpt_bytes
      || budgets.max_total_bytes > 65_536 || !Number.isSafeInteger(budgets.max_page_bytes)
      || budgets.max_page_bytes < budgets.max_excerpt_bytes || budgets.max_page_bytes > 1_048_576
      || !Number.isSafeInteger(options.max_age_ms) || options.max_age_ms < 1
      || options.max_age_ms > 31 * 86_400_000 || !Number.isSafeInteger(options.expiry_ms)
      || options.expiry_ms <= options.max_age_ms || options.expiry_ms > 31 * 86_400_000) {
      throw new TypeError("SECOND_BRAIN_ADAPTER_CONFIG_INVALID");
    }
  }

  async search(query: string): Promise<SecondBrainReadOutcome> {
    const checkedAt = this.options.clock();
    if (query.length === 0 || Buffer.byteLength(query, "utf8") > 4_096) return invalid("SECOND_BRAIN_QUERY_INVALID", checkedAt);
    const called = await this.call("sb_search", { query, limit: this.options.budgets.max_hits }, checkedAt);
    if (called.kind === "adapter") return called.outcome;
    if (called.outcome.kind !== "data") return this.nonData(called.outcome, checkedAt);
    const value = called.outcome.value;
    if (!exact(value, ["results"]) || !Array.isArray(value["results"])) return invalid("SECOND_BRAIN_SEARCH_MALFORMED", checkedAt);
    const parsed = this.searchRows(value["results"]);
    if (parsed === undefined) return invalid("SECOND_BRAIN_SEARCH_MALFORMED", checkedAt);
    if (parsed.length > this.options.budgets.max_hits) return invalid("SECOND_BRAIN_RESULTS_OVERSIZE", checkedAt);
    return this.readPages(parsed.map(row => row.page_id), checkedAt);
  }

  async readPage(pageId: string): Promise<SecondBrainReadOutcome> {
    const checkedAt = this.options.clock();
    if (!validPageId(pageId)) return invalid("SECOND_BRAIN_PAGE_ID_INVALID", checkedAt);
    return this.readPageAt(pageId, checkedAt);
  }

  async recentChanges(days: number): Promise<SecondBrainReadOutcome> {
    const checkedAt = this.options.clock();
    if (!Number.isSafeInteger(days) || days < 0 || days > 365) return invalid("SECOND_BRAIN_DAYS_INVALID", checkedAt);
    const called = await this.call("sb_recent_changes", { days }, checkedAt);
    if (called.kind === "adapter") return called.outcome;
    if (called.outcome.kind !== "data") return this.nonData(called.outcome, checkedAt);
    const value = called.outcome.value;
    if (!exact(value, ["changes"]) || !Array.isArray(value["changes"])) return invalid("SECOND_BRAIN_CHANGES_MALFORMED", checkedAt);
    if (value["changes"].length > this.options.budgets.max_hits) return invalid("SECOND_BRAIN_RESULTS_OVERSIZE", checkedAt);
    const pageIds: string[] = [];
    for (const candidate of value["changes"]) {
      if (!isRecord(candidate) || !exact(candidate, ["change", "date", "page_id"]) || !validPageId(candidate["page_id"])
        || (candidate["change"] !== "added" && candidate["change"] !== "modified")
        || typeof candidate["date"] !== "string" || !/^\d{4}-\d\d-\d\d$/.test(candidate["date"])) {
        return invalid("SECOND_BRAIN_CHANGES_MALFORMED", checkedAt);
      }
      const date = new Date(`${candidate["date"]}T00:00:00.000Z`);
      if (!Number.isFinite(date.getTime()) || date.getTime() > checkedAt.getTime()) return invalid("SECOND_BRAIN_TIME_INVALID", checkedAt);
      pageIds.push(candidate["page_id"]);
    }
    return this.readPages(pageIds, checkedAt);
  }

  async openConflicts(): Promise<SecondBrainReadOutcome> {
    const checkedAt = this.options.clock();
    const called = await this.call("sb_open_conflicts", {}, checkedAt);
    if (called.kind === "adapter") return called.outcome;
    if (called.outcome.kind !== "data") return this.nonData(called.outcome, checkedAt);
    const value = called.outcome.value;
    if (!exact(value, ["conflicts"]) || !Array.isArray(value["conflicts"])) return invalid("SECOND_BRAIN_CONFLICTS_MALFORMED", checkedAt);
    const rows = this.conflictRows(value["conflicts"]);
    if (rows === undefined) return invalid("SECOND_BRAIN_CONFLICTS_MALFORMED", checkedAt);
    if (rows.length > this.options.budgets.max_hits) return invalid("SECOND_BRAIN_RESULTS_OVERSIZE", checkedAt);
    const conflicts: SecondBrainConflict[] = [];
    for (const row of rows) {
      const result = await this.readPageAt(`conflicts/${row.conflict_id}`, checkedAt);
      if (result.kind === "invalid" || result.kind === "offline" || result.kind === "unavailable") return result;
      if (result.kind === "no_data") return invalid("SECOND_BRAIN_CONFLICT_MALFORMED", checkedAt);
      if (result.kind === "conflicts") { conflicts.push(...result.conflicts); continue; }
      const left = result.evidence[0];
      const right = result.evidence[1];
      if (left === undefined || right === undefined) return invalid("SECOND_BRAIN_CONFLICT_MALFORMED", checkedAt);
      conflicts.push({ conflict_id: row.conflict_id, page_id: row.page_id, state: "unresolved", left, right });
    }
    conflicts.sort((left, right) => left.conflict_id.localeCompare(right.conflict_id));
    return { kind: "conflicts", checked_at: checkedAt.toISOString(), conflicts };
  }

  private async readPages(pageIds: readonly string[], checkedAt: Date): Promise<SecondBrainReadOutcome> {
    const evidence: SecondBrainEvidence[] = [];
    for (const pageId of new Set(pageIds)) {
      const result = await this.readPageAt(pageId, checkedAt);
      if (result.kind === "current" || result.kind === "stale") evidence.push(...result.evidence);
      else return result;
    }
    return combineEvidence(evidence, this.options, checkedAt);
  }

  private async readPageAt(pageId: string, checkedAt: Date): Promise<SecondBrainReadOutcome> {
    const called = await this.call("sb_read_page", { id: pageId }, checkedAt);
    if (called.kind === "adapter") return called.outcome;
    if (called.outcome.kind !== "data") return this.nonData(called.outcome, checkedAt);
    const parsed = parseSecondBrainPage({
      value: called.outcome.value,
      requestedPageId: pageId,
      checkedAt,
      budgets: this.options.budgets,
      maxAgeMs: this.options.max_age_ms,
      expiryMs: this.options.expiry_ms,
    });
    switch (parsed.kind) {
      case "invalid": return invalid(parsed.code, checkedAt);
      case "conflicts": return { kind: "conflicts", checked_at: checkedAt.toISOString(), conflicts: parsed.conflicts };
      case "current": return { kind: "current", checked_at: checkedAt.toISOString(), evidence: parsed.evidence };
      case "stale": return { kind: "stale", code: "SECOND_BRAIN_EVIDENCE_STALE", checked_at: checkedAt.toISOString(), evidence: parsed.evidence };
      default: { const exhaustive: never = parsed; return exhaustive; }
    }
  }

  private async call(
    method: SecondBrainReadMethod,
    arguments_: Readonly<Record<string, unknown>>,
    checkedAt: Date,
  ): Promise<CallResult> {
    try {
      return { kind: "transport", outcome: await this.options.transport.call(method, arguments_) };
    } catch (error) {
      if (!(error instanceof SecondBrainTransportError)) throw error;
      const kind = OFFLINE_CODES.some(code => code === error.code) ? "offline" : error.disposition === "fatal" ? "invalid" : "unavailable";
      return { kind: "adapter", outcome: { kind, code: error.code, checked_at: checkedAt.toISOString() } };
    }
  }

  private nonData(outcome: Exclude<SecondBrainOutcome, { readonly kind: "data" }>, checkedAt: Date): SecondBrainReadOutcome {
    switch (outcome.kind) {
      case "no_data": return {
        kind: "no_data",
        checked_at: checkedAt.toISOString(),
        fresh_until: new Date(checkedAt.getTime() + CHECK_FRESH_MS).toISOString(),
      };
      case "error": return { kind: "unavailable", code: outcome.code, checked_at: checkedAt.toISOString() };
      default: { const exhaustive: never = outcome; return exhaustive; }
    }
  }

  private searchRows(value: readonly unknown[]): readonly SearchRow[] | undefined {
    const rows: SearchRow[] = [];
    for (const candidate of value) {
      if (!isRecord(candidate) || !exact(candidate, ["page_id", "score", "section", "snippet"])
        || !validPageId(candidate["page_id"]) || typeof candidate["section"] !== "string"
        || typeof candidate["snippet"] !== "string" || typeof candidate["score"] !== "number"
        || !Number.isFinite(candidate["score"]) || Buffer.byteLength(candidate["snippet"], "utf8") > this.options.budgets.max_excerpt_bytes) {
        return undefined;
      }
      rows.push({ page_id: candidate["page_id"], section: candidate["section"], snippet: candidate["snippet"], score: candidate["score"] });
    }
    return rows;
  }

  private conflictRows(value: readonly unknown[]): readonly ConflictRow[] | undefined {
    const rows: ConflictRow[] = [];
    for (const candidate of value) {
      if (!isRecord(candidate) || !exact(candidate, ["conflict_id", "page_id", "summary"])
        || !validPageId(candidate["conflict_id"]) || !validPageId(candidate["page_id"])
        || typeof candidate["summary"] !== "string"
        || Buffer.byteLength(candidate["summary"], "utf8") > this.options.budgets.max_excerpt_bytes) return undefined;
      rows.push({ conflict_id: candidate["conflict_id"], page_id: candidate["page_id"], summary: candidate["summary"] });
    }
    return rows;
  }
}

export function createSecondBrainReadAdapter(options: SecondBrainAdapterOptions): SecondBrainReadAdapter {
  return new BoundedSecondBrainReadAdapter(options);
}
