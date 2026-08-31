import { parseSecondBrainPage } from "./second-brain-evidence-parser.js";
import { normalizeSecondBrainProviderRecord } from "./second-brain-provider-value.js";
import { secondBrainUtf8Bytes, SecondBrainReadBudget } from "./second-brain-read-budget.js";
import {
  combineSecondBrainEvidence,
  hasExactSecondBrainKeys,
  isSecondBrainPageId,
  isSecondBrainRecord,
  parseSecondBrainConflictRows,
  parseSecondBrainSearchRows,
} from "./second-brain-read-values.js";
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

export { createSecondBrainWriteRequestAdapter } from "./second-brain-write-adapter.js";
export type {
  SecondBrainAdapterBudgets,
  SecondBrainAdapterOptions,
  SecondBrainConflict,
  SecondBrainEvidence,
  SecondBrainReadAdapter,
  SecondBrainReadOutcome,
  SecondBrainSensitivity,
  SecondBrainWriteOperation,
  SecondBrainWriteOutcome,
  SecondBrainWriteRequestAdapter,
  SecondBrainWriteRequestV1,
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

function invalid(code: string, checkedAt: Date): SecondBrainReadOutcome {
  return { kind: "invalid", code, checked_at: checkedAt.toISOString() };
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
    const requestBudget = new SecondBrainReadBudget(this.options.budgets);
    if (query.length === 0 || secondBrainUtf8Bytes(query) > 4_096) {
      return invalid("SECOND_BRAIN_QUERY_INVALID", checkedAt);
    }
    const called = await this.call("sb_search", { query, limit: this.options.budgets.max_hits }, checkedAt);
    if (called.kind === "adapter") return called.outcome;
    if (called.outcome.kind !== "data") return this.nonData(called.outcome, checkedAt);
    const value = called.outcome.value;
    const budgetCode = requestBudget.consumeProvider(value);
    if (budgetCode !== undefined) return invalid(budgetCode, checkedAt);
    if (!hasExactSecondBrainKeys(value, ["results"]) || !Array.isArray(value["results"])) {
      return invalid("SECOND_BRAIN_SEARCH_MALFORMED", checkedAt);
    }
    const parsed = parseSecondBrainSearchRows(value["results"], this.options.budgets);
    if (parsed === undefined) return invalid("SECOND_BRAIN_SEARCH_MALFORMED", checkedAt);
    if (parsed.length > this.options.budgets.max_hits) return invalid("SECOND_BRAIN_RESULTS_OVERSIZE", checkedAt);
    return this.readPages(parsed.map(row => row.page_id), checkedAt, requestBudget);
  }

  async readPage(pageId: string): Promise<SecondBrainReadOutcome> {
    const checkedAt = this.options.clock();
    const requestBudget = new SecondBrainReadBudget(this.options.budgets);
    if (!isSecondBrainPageId(pageId)) return invalid("SECOND_BRAIN_PAGE_ID_INVALID", checkedAt);
    const result = await this.readPageAt(pageId, checkedAt, requestBudget);
    return this.bounded(result, checkedAt, requestBudget);
  }

  async recentChanges(days: number): Promise<SecondBrainReadOutcome> {
    const checkedAt = this.options.clock();
    const requestBudget = new SecondBrainReadBudget(this.options.budgets);
    if (!Number.isSafeInteger(days) || days < 0 || days > 365) return invalid("SECOND_BRAIN_DAYS_INVALID", checkedAt);
    const called = await this.call("sb_recent_changes", { days }, checkedAt);
    if (called.kind === "adapter") return called.outcome;
    if (called.outcome.kind !== "data") return this.nonData(called.outcome, checkedAt);
    const value = called.outcome.value;
    const budgetCode = requestBudget.consumeProvider(value);
    if (budgetCode !== undefined) return invalid(budgetCode, checkedAt);
    if (!hasExactSecondBrainKeys(value, ["changes"]) || !Array.isArray(value["changes"])) {
      return invalid("SECOND_BRAIN_CHANGES_MALFORMED", checkedAt);
    }
    if (value["changes"].length > this.options.budgets.max_hits) {
      return invalid("SECOND_BRAIN_RESULTS_OVERSIZE", checkedAt);
    }
    const pageIds: string[] = [];
    for (const candidate of value["changes"]) {
      if (!isSecondBrainRecord(candidate)
        || !hasExactSecondBrainKeys(candidate, ["change", "date", "page_id"])
        || !isSecondBrainPageId(candidate["page_id"])
        || (candidate["change"] !== "added" && candidate["change"] !== "modified")
        || typeof candidate["date"] !== "string"
        || !/^\d{4}-\d\d-\d\d$/.test(candidate["date"])) {
        return invalid("SECOND_BRAIN_CHANGES_MALFORMED", checkedAt);
      }
      const date = new Date(`${candidate["date"]}T00:00:00.000Z`);
      if (!Number.isFinite(date.getTime()) || date.getTime() > checkedAt.getTime()) {
        return invalid("SECOND_BRAIN_TIME_INVALID", checkedAt);
      }
      pageIds.push(candidate["page_id"]);
    }
    return this.readPages(pageIds, checkedAt, requestBudget);
  }

  async openConflicts(): Promise<SecondBrainReadOutcome> {
    const checkedAt = this.options.clock();
    const requestBudget = new SecondBrainReadBudget(this.options.budgets);
    const called = await this.call("sb_open_conflicts", {}, checkedAt);
    if (called.kind === "adapter") return called.outcome;
    if (called.outcome.kind !== "data") return this.nonData(called.outcome, checkedAt);
    const value = called.outcome.value;
    const budgetCode = requestBudget.consumeProvider(value);
    if (budgetCode !== undefined) return invalid(budgetCode, checkedAt);
    if (!hasExactSecondBrainKeys(value, ["conflicts"]) || !Array.isArray(value["conflicts"])) {
      return invalid("SECOND_BRAIN_CONFLICTS_MALFORMED", checkedAt);
    }
    const rows = parseSecondBrainConflictRows(value["conflicts"], this.options.budgets);
    if (rows === undefined) return invalid("SECOND_BRAIN_CONFLICTS_MALFORMED", checkedAt);
    if (rows.length > this.options.budgets.max_hits) return invalid("SECOND_BRAIN_RESULTS_OVERSIZE", checkedAt);
    const conflicts: SecondBrainConflict[] = [];
    for (const row of rows) {
      const result = await this.readPageAt(`conflicts/${row.conflict_id}`, checkedAt, requestBudget);
      if (result.kind === "invalid" || result.kind === "offline" || result.kind === "unavailable") return result;
      if (result.kind === "no_data" || result.kind === "conflicts" || result.evidence.length !== 2) {
        return invalid("SECOND_BRAIN_CONFLICT_SHAPE_INVALID", checkedAt);
      }
      const left = result.evidence[0];
      const right = result.evidence[1];
      if (left === undefined || right === undefined || this.sideIdentity(left) === this.sideIdentity(right)) {
        return invalid("SECOND_BRAIN_CONFLICT_SHAPE_INVALID", checkedAt);
      }
      conflicts.push({ conflict_id: row.conflict_id, page_id: row.page_id, state: "unresolved", left, right });
    }
    conflicts.sort((left, right) => left.conflict_id.localeCompare(right.conflict_id));
    return this.bounded({ kind: "conflicts", checked_at: checkedAt.toISOString(), conflicts }, checkedAt, requestBudget);
  }

  private async readPages(
    pageIds: readonly string[],
    checkedAt: Date,
    requestBudget: SecondBrainReadBudget,
  ): Promise<SecondBrainReadOutcome> {
    const evidence: SecondBrainEvidence[] = [];
    for (const pageId of new Set(pageIds)) {
      const result = await this.readPageAt(pageId, checkedAt, requestBudget);
      if (result.kind === "current" || result.kind === "stale") evidence.push(...result.evidence);
      else return result;
    }
    return this.bounded(combineSecondBrainEvidence(evidence, checkedAt), checkedAt, requestBudget);
  }

  private async readPageAt(
    pageId: string,
    checkedAt: Date,
    requestBudget: SecondBrainReadBudget,
  ): Promise<SecondBrainReadOutcome> {
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
      requestBudget,
    });
    switch (parsed.kind) {
      case "invalid": return invalid(parsed.code, checkedAt);
      case "conflicts": return { kind: "conflicts", checked_at: checkedAt.toISOString(), conflicts: parsed.conflicts };
      case "current": return { kind: "current", checked_at: checkedAt.toISOString(), evidence: parsed.evidence };
      case "stale": return { kind: "stale", code: "SECOND_BRAIN_EVIDENCE_STALE", checked_at: checkedAt.toISOString(), evidence: parsed.evidence };
      default: { const exhaustive: never = parsed; return exhaustive; }
    }
  }

  private bounded(
    outcome: SecondBrainReadOutcome,
    checkedAt: Date,
    requestBudget: SecondBrainReadBudget,
  ): SecondBrainReadOutcome {
    if (outcome.kind !== "current" && outcome.kind !== "stale" && outcome.kind !== "conflicts") return outcome;
    const budgetCode = requestBudget.consumeReturned(outcome);
    return budgetCode === undefined ? outcome : invalid(budgetCode, checkedAt);
  }

  private sideIdentity(evidence: SecondBrainEvidence): string {
    return `${evidence.sid}\0${evidence.source_ref}\0${evidence.content_digest}`;
  }

  private async call(
    method: SecondBrainReadMethod,
    arguments_: Readonly<Record<string, unknown>>,
    checkedAt: Date,
  ): Promise<CallResult> {
    try {
      const outcome = await this.options.transport.call(method, arguments_);
      if (outcome.kind !== "data") return { kind: "transport", outcome };
      const value = normalizeSecondBrainProviderRecord(outcome.value);
      return value === undefined
        ? { kind: "adapter", outcome: invalid("SECOND_BRAIN_PROVIDER_VALUE_INVALID", checkedAt) }
        : { kind: "transport", outcome: { kind: "data", value } };
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
}

export function createSecondBrainReadAdapter(options: SecondBrainAdapterOptions): SecondBrainReadAdapter {
  return new BoundedSecondBrainReadAdapter(options);
}
