import { callSecondBrainRead } from "./second-brain-adapter-call.js";
import { parseSecondBrainPage } from "./second-brain-evidence-parser.js";
import { secondBrainUtf8Bytes, SecondBrainReadBudget } from "./second-brain-read-budget.js";
import {
  boundSecondBrainOutcome,
  combineSecondBrainEvidence,
  hasExactSecondBrainKeys,
  isSecondBrainPageId,
  isSecondBrainRecord,
  nonDataSecondBrainOutcome,
  parseSecondBrainConflictRows,
  parseSecondBrainSearchRows,
  type SecondBrainSearchRow,
} from "./second-brain-read-values.js";
import {
  type SecondBrainAdapterOptions,
  type SecondBrainConflict,
  type SecondBrainEvidence,
  type SecondBrainGenerationBinding,
  type SecondBrainReadAdapter,
  type SecondBrainReadOutcome,
} from "./second-brain-adapter-types.js";
import { SECOND_BRAIN_GENERATION_BINDING_KEY, secondBrainEvidenceGenerationMatches,
  secondBrainGenerationBinding } from "./second-brain-generation-read.js";
import type { SecondBrainReadMethod } from "./second-brain-transport.js";

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
  SecondBrainWriteRequest,
  SecondBrainWriteRequestAdapter,
  SecondBrainWriteRequestV1,
  SecondBrainWriteRequestV2,
  SecondBrainWriteRequestV3,
  SecondBrainRememberWriteRequest,
  SecondBrainWriteAcceptedV3,
  SecondBrainRememberWriteAccepted,
} from "./second-brain-adapter-types.js";
export { SECOND_BRAIN_SENSITIVITIES, SECOND_BRAIN_SOURCE_ID, SECOND_BRAIN_TRUST } from "./second-brain-adapter-types.js";

type PageSelection = Pick<SecondBrainSearchRow, "page_id" | "record_id" | "record_digest">;
type PageBatch = { readonly selections: readonly PageSelection[]; readonly checkedAt: Date;
  readonly requestBudget: SecondBrainReadBudget; readonly generation: SecondBrainGenerationBinding | undefined };


function invalid(code: string, checkedAt: Date): SecondBrainReadOutcome {
  return { kind: "invalid", code, checked_at: checkedAt.toISOString() };
}
class BoundedSecondBrainReadAdapter implements SecondBrainReadAdapter {
  readonly contract_profile: "schema3-read-only" | "schema4";
  private readonly unboundGenerations = new Map<SecondBrainReadMethod, string>();
  constructor(private readonly options: SecondBrainAdapterOptions) {
    this.contract_profile = options.contract_profile ?? "schema3-read-only";
    const { budgets } = options;
    const profile = options.budget_profile ?? "interactive";
    const totalCap = profile === "record-set-v1" ? 262_144 : 65_536;
    const pageCap = profile === "record-set-v1" ? 262_144 : 1_048_576;
    if ((profile !== "interactive" && profile !== "record-set-v1")
      || (profile === "record-set-v1" && this.contract_profile !== "schema4")) {
      throw new TypeError("SECOND_BRAIN_ADAPTER_CONFIG_INVALID");
    }
    if (!Number.isSafeInteger(budgets.max_hits) || budgets.max_hits < 1 || budgets.max_hits > 32
      || !Number.isSafeInteger(budgets.max_excerpt_bytes) || budgets.max_excerpt_bytes < 1 || budgets.max_excerpt_bytes > 4_096
      || !Number.isSafeInteger(budgets.max_total_bytes) || budgets.max_total_bytes < budgets.max_excerpt_bytes
      || budgets.max_total_bytes > totalCap || !Number.isSafeInteger(budgets.max_page_bytes)
      || budgets.max_page_bytes < budgets.max_excerpt_bytes || budgets.max_page_bytes > pageCap
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
    if (called.outcome.kind !== "data") return nonDataSecondBrainOutcome(called.outcome, checkedAt);
    const value = called.outcome.value;
    const budgetCode = requestBudget.consumeProvider(value);
    if (budgetCode !== undefined) return invalid(budgetCode, checkedAt);
    const generation = secondBrainGenerationBinding(value);
    if (!hasExactSecondBrainKeys(value, generation === undefined ? ["results"]
      : ["results", SECOND_BRAIN_GENERATION_BINDING_KEY]) || !Array.isArray(value["results"])) {
      return invalid("SECOND_BRAIN_SEARCH_MALFORMED", checkedAt);
    }
    const parsed = parseSecondBrainSearchRows(value["results"], this.options.budgets);
    if (parsed === undefined) return invalid("SECOND_BRAIN_SEARCH_MALFORMED", checkedAt);
    if (parsed.length > this.options.budgets.max_hits) return invalid("SECOND_BRAIN_RESULTS_OVERSIZE", checkedAt);
    return this.readPages({ selections: parsed, checkedAt, requestBudget, generation });
  }

  async readPage(pageId: string): Promise<SecondBrainReadOutcome> {
    const checkedAt = this.options.clock();
    const requestBudget = new SecondBrainReadBudget(this.options.budgets);
    if (!isSecondBrainPageId(pageId)) return invalid("SECOND_BRAIN_PAGE_ID_INVALID", checkedAt);
    const result = await this.readPageAt(pageId, checkedAt, requestBudget);
    return boundSecondBrainOutcome(result, checkedAt, requestBudget);
  }

  async recentChanges(days: number): Promise<SecondBrainReadOutcome> {
    const checkedAt = this.options.clock();
    const requestBudget = new SecondBrainReadBudget(this.options.budgets);
    if (!Number.isSafeInteger(days) || days < 0 || days > 365) return invalid("SECOND_BRAIN_DAYS_INVALID", checkedAt);
    const called = await this.call("sb_recent_changes", { days }, checkedAt);
    if (called.kind === "adapter") return called.outcome;
    if (called.outcome.kind !== "data") return nonDataSecondBrainOutcome(called.outcome, checkedAt);
    const value = called.outcome.value;
    const budgetCode = requestBudget.consumeProvider(value);
    if (budgetCode !== undefined) return invalid(budgetCode, checkedAt);
    const generation = secondBrainGenerationBinding(value);
    if (!hasExactSecondBrainKeys(value, generation === undefined ? ["changes"]
      : ["changes", SECOND_BRAIN_GENERATION_BINDING_KEY]) || !Array.isArray(value["changes"])) {
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
    return this.readPages({ selections: pageIds.map(page_id => ({ page_id, record_id: null,
      record_digest: null })), checkedAt, requestBudget, generation });
  }

  async openConflicts(): Promise<SecondBrainReadOutcome> {
    const checkedAt = this.options.clock();
    const requestBudget = new SecondBrainReadBudget(this.options.budgets);
    const called = await this.call("sb_open_conflicts", {}, checkedAt);
    if (called.kind === "adapter") return called.outcome;
    if (called.outcome.kind !== "data") return nonDataSecondBrainOutcome(called.outcome, checkedAt);
    const value = called.outcome.value;
    const budgetCode = requestBudget.consumeProvider(value);
    if (budgetCode !== undefined) return invalid(budgetCode, checkedAt);
    const generation = secondBrainGenerationBinding(value);
    if (!hasExactSecondBrainKeys(value, generation === undefined ? ["conflicts"]
      : ["conflicts", SECOND_BRAIN_GENERATION_BINDING_KEY]) || !Array.isArray(value["conflicts"])) {
      return invalid("SECOND_BRAIN_CONFLICTS_MALFORMED", checkedAt);
    }
    const rows = parseSecondBrainConflictRows(value["conflicts"], this.options.budgets);
    if (rows === undefined) return invalid("SECOND_BRAIN_CONFLICTS_MALFORMED", checkedAt);
    if (rows.length > this.options.budgets.max_hits) return invalid("SECOND_BRAIN_RESULTS_OVERSIZE", checkedAt);
    const conflicts: SecondBrainConflict[] = [];
    for (const row of rows) {
      const result = await this.readPageAt(`conflicts/${row.conflict_id}`, checkedAt, requestBudget);
      if (result.kind === "invalid" || result.kind === "offline" || result.kind === "unavailable") return result;
      if (!secondBrainEvidenceGenerationMatches(result, generation)) {
        return invalid("SECOND_BRAIN_GENERATION_CHANGED", checkedAt);
      }
      if (result.kind === "no_data" || result.kind === "conflicts" || result.evidence.length !== 2) {
        return invalid("SECOND_BRAIN_CONFLICT_SHAPE_INVALID", checkedAt);
      }
      const left = result.evidence[0];
      const right = result.evidence[1];
      if (left === undefined || right === undefined
        || `${left.sid}\0${left.source_ref}\0${left.content_digest}`
          === `${right.sid}\0${right.source_ref}\0${right.content_digest}`) {
        return invalid("SECOND_BRAIN_CONFLICT_SHAPE_INVALID", checkedAt);
      }
      conflicts.push({ conflict_id: row.conflict_id, page_id: row.page_id, state: "unresolved", left, right });
    }
    conflicts.sort((left, right) => left.conflict_id.localeCompare(right.conflict_id));
    return boundSecondBrainOutcome({ kind: "conflicts", checked_at: checkedAt.toISOString(), conflicts }, checkedAt, requestBudget);
  }

  private async readPages(input: PageBatch): Promise<SecondBrainReadOutcome> {
    const evidence: SecondBrainEvidence[] = [];
    const pages = new Map<string, PageSelection[]>();
    for (const selection of input.selections) {
      const selections = pages.get(selection.page_id) ?? [];
      selections.push(selection);
      pages.set(selection.page_id, selections);
    }
    for (const [pageId, selections] of pages) {
      const result = await this.readPageAt(pageId, input.checkedAt, input.requestBudget);
      if (result.kind !== "current" && result.kind !== "stale") return result;
      if (!secondBrainEvidenceGenerationMatches(result, input.generation)) {
        return invalid("SECOND_BRAIN_GENERATION_CHANGED", input.checkedAt);
      }
      for (const selection of selections) {
        const selected = selection.record_id === null ? result.evidence : result.evidence.filter(item =>
          item.record?.record_id === selection.record_id && item.record.record_digest === selection.record_digest);
        if (selection.record_id !== null && selected.length !== 1) {
          return invalid("SECOND_BRAIN_RECORD_SELECTION_INVALID", input.checkedAt);
        }
        evidence.push(...selected);
      }
    }
    return boundSecondBrainOutcome(combineSecondBrainEvidence(evidence, input.checkedAt), input.checkedAt, input.requestBudget);
  }

  private async readPageAt(
    pageId: string,
    checkedAt: Date,
    requestBudget: SecondBrainReadBudget,
  ): Promise<SecondBrainReadOutcome> {
    const called = await this.call("sb_read_page", { id: pageId }, checkedAt);
    if (called.kind === "adapter") return called.outcome;
    if (called.outcome.kind !== "data") return nonDataSecondBrainOutcome(called.outcome, checkedAt);
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

  private call(method: SecondBrainReadMethod, arguments_: Readonly<Record<string, unknown>>, checkedAt: Date) {
    return callSecondBrainRead(this.options, this.contract_profile, this.unboundGenerations, method, arguments_, checkedAt);
  }

}

export function createSecondBrainReadAdapter(options: SecondBrainAdapterOptions): SecondBrainReadAdapter {
  const validated = new BoundedSecondBrainReadAdapter(options);
  // Each public read owns its generation comparisons. Later or concurrent reads
  // may observe another committed generation without sharing mutable pin state.
  return {
    contract_profile: validated.contract_profile,
    search: query => new BoundedSecondBrainReadAdapter(options).search(query),
    readPage: pageId => new BoundedSecondBrainReadAdapter(options).readPage(pageId),
    recentChanges: days => new BoundedSecondBrainReadAdapter(options).recentChanges(days),
    openConflicts: () => new BoundedSecondBrainReadAdapter(options).openConflicts(),
  };
}
