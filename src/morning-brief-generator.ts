import { createHash } from "node:crypto";
import { canonicalize } from "./canonical.js";
import {
  MORNING_BRIEF_OMISSION_REASONS,
  type MorningBriefCitation,
  type MorningBriefInput,
  type MorningBriefItem,
  type MorningBriefOmission,
  type MorningBriefOmissionReason,
  type MorningBriefPriority,
  type MorningBriefRecord,
  type MorningBriefResult,
} from "./morning-brief-types.js";
import { PRIORITY_LEXICOGRAPHIC_POLICY } from "./priority-engine-contracts.js";

const hash = (value: unknown): string => createHash("sha256").update(canonicalize(value)).digest("hex");
const compareText = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;
const ordinal = (left: string, right: string, order: readonly string[]): number => order.indexOf(left) - order.indexOf(right);
function comparePriority(left: MorningBriefPriority, right: MorningBriefPriority): number {
  const comparisons = [
    ordinal(left.owner_safety_gate, right.owner_safety_gate, PRIORITY_LEXICOGRAPHIC_POLICY.owner_safety_gate),
    ordinal(left.customer_impact, right.customer_impact, PRIORITY_LEXICOGRAPHIC_POLICY.customer_impact),
    ordinal(left.deadline_bucket, right.deadline_bucket, PRIORITY_LEXICOGRAPHIC_POLICY.deadline_bucket),
    ordinal(left.dependency_blocking, right.dependency_blocking, PRIORITY_LEXICOGRAPHIC_POLICY.dependency_blocking),
    ordinal(left.irreversible_risk, right.irreversible_risk, PRIORITY_LEXICOGRAPHIC_POLICY.irreversible_risk),
    ordinal(left.effort_cost, right.effort_cost, PRIORITY_LEXICOGRAPHIC_POLICY.effort_cost),
  ];
  return comparisons.find(value => value !== 0) ?? compareText(left.stable_identity, right.stable_identity);
}
function compareRecord(left: MorningBriefRecord, right: MorningBriefRecord): number {
  if (left.owner_decision_required !== right.owner_decision_required) return left.owner_decision_required ? -1 : 1;
  return comparePriority(left.priority, right.priority) || compareText(left.semantic_key, right.semantic_key)
    || compareText(left.item_id, right.item_id);
}
function truncateUtf8(value: string, maximum: number): string {
  if (Buffer.byteLength(value, "utf8") <= maximum) return value;
  let result = "";
  for (const character of value) {
    if (Buffer.byteLength(`${result}${character}`, "utf8") > maximum) break;
    result += character;
  }
  return result;
}
function uniqueSorted(values: readonly string[]): readonly string[] { return [...new Set(values)].sort(compareText); }
function confidence(values: readonly MorningBriefRecord[]): "low" | "medium" | "high" {
  const order = ["low", "medium", "high"] as const;
  return order.find(value => values.some(item => item.confidence === value)) ?? "high";
}
function trust(values: readonly MorningBriefRecord[]): "confirmed" | "inferred" {
  return values.some(item => item.trust === "inferred") ? "inferred" : "confirmed";
}
function citations(values: readonly MorningBriefRecord[]): readonly MorningBriefCitation[] {
  return [...values.flatMap(item => item.citations)].sort((left, right) => compareText(left.link_id, right.link_id));
}
function item(values: readonly MorningBriefRecord[], maximumCopyBytes: number, maximumSources: number): MorningBriefItem {
  const sorted = [...values].sort(compareRecord);
  const representative = sorted[0];
  if (representative === undefined) throw new MorningBriefContractInvariantError();
  const sourceIds = uniqueSorted(sorted.flatMap(value => value.source_ids)).slice(0, maximumSources);
  const selectedCitations = citations(sorted).filter(value => sourceIds.includes(value.source_id)).slice(0, maximumSources);
  const core = {
    recommendation_id: representative.recommendation_id, action_id: representative.action_id,
    contributing_item_ids: uniqueSorted(sorted.map(value => value.item_id)),
    contributing_recommendation_ids: uniqueSorted(sorted.map(value => value.recommendation_id)),
    contributing_action_ids: uniqueSorted(sorted.map(value => value.action_id)), source_ids: sourceIds, citations: selectedCitations,
    copy: truncateUtf8(representative.copy, maximumCopyBytes),
    observed_at: [...sorted.map(value => value.observed_at)].sort().at(-1) ?? representative.observed_at,
    valid_from: [...sorted.map(value => value.valid_from)].sort().at(-1) ?? representative.valid_from,
    valid_until: [...sorted.map(value => value.valid_until)].sort()[0] ?? representative.valid_until,
    fresh_until: [...sorted.map(value => value.fresh_until)].sort()[0] ?? representative.fresh_until,
    trust: trust(sorted), confidence: confidence(sorted), owner_decision_required: sorted.some(value => value.owner_decision_required),
    deadline: uniqueSorted(sorted.flatMap(value => value.deadline === null ? [] : [value.deadline]))[0] ?? null,
    priority: representative.priority,
  };
  const provenance = { contributing_item_ids: core.contributing_item_ids, contributing_recommendation_ids: core.contributing_recommendation_ids,
    contributing_action_ids: core.contributing_action_ids, source_ids: core.source_ids, citations: core.citations,
    observed_at: core.observed_at, valid_from: core.valid_from, valid_until: core.valid_until, fresh_until: core.fresh_until };
  const itemId = `brief-item:v1:${hash({ semantic_key: representative.semantic_key })}`;
  return { item_id: itemId, ...core, provenance_digest: `sha256:${hash(provenance)}`, canonical_digest: `sha256:${hash({ item_id: itemId, ...core })}` };
}
export class MorningBriefContractInvariantError extends Error {
  readonly name = "MorningBriefContractInvariantError";
  constructor() { super("MORNING_BRIEF_INVARIANT_FAILURE"); }
}
function omissionReason(value: MorningBriefRecord, clock: string): MorningBriefOmissionReason | null {
  if (value.state === "deleted" || value.state === "corrupt" || value.state === "conflicting" || value.state === "unrelated"
    || value.state === "insufficient_citation") return value.state;
  if (value.state === "untrusted" || value.trust === "untrusted") return "untrusted";
  if (value.state === "expired" || Date.parse(value.valid_until) <= Date.parse(clock)) return "expired";
  if (value.state === "stale" || Date.parse(value.fresh_until) <= Date.parse(clock)) return "stale";
  if (value.citations.length === 0 || value.source_ids.length === 0) return "insufficient_citation";
  return null;
}
type Sections = {
  readonly needs: readonly MorningBriefItem[];
  readonly waiting: readonly MorningBriefItem[];
  readonly fyi: readonly MorningBriefItem[];
};
function omissionList(counts: ReadonlyMap<MorningBriefOmissionReason, number>): readonly MorningBriefOmission[] {
  return MORNING_BRIEF_OMISSION_REASONS.flatMap(reason => {
    const count = counts.get(reason) ?? 0;
    return count === 0 ? [] : [{ reason, count }];
  });
}
function externalReason(input: MorningBriefInput): string | null {
  if (!input.external_intelligence.enabled) return "external_intelligence_disabled";
  return input.external_intelligence.state === "available" ? null : `external_intelligence_${input.external_intelligence.state}`;
}
function result(input: MorningBriefInput, sections: Sections, counts: ReadonlyMap<MorningBriefOmissionReason, number>): MorningBriefResult {
  const omissions = omissionList(counts);
  const itemCount = sections.needs.length + sections.waiting.length + sections.fyi.length;
  const noData = input.context_readiness === "no_data" && input.items.length === 0;
  const noAuthoritativeData = !noData && itemCount === 0;
  const core = {
    schema_version: 1 as const, generated_at: input.generated_at, context_readiness: input.context_readiness,
    needs_you_first: sections.needs, waiting: sections.waiting, fyi: sections.fyi, omissions,
    omitted_count: omissions.reduce((sum, value) => sum + value.count, 0),
    degradation_reasons: uniqueSorted([
      ...(input.context_readiness === "degraded" ? ["context_degraded"] : []),
      ...omissions.map(value => `omitted_${value.reason}`), ...(externalReason(input) === null ? [] : [externalReason(input) ?? ""]),
    ]),
    abstention_reasons: noData ? ["no_data"] : noAuthoritativeData ? ["no_authoritative_data"] : [],
    external_intelligence: { enabled: input.external_intelligence.enabled, skip_reason: externalReason(input) }, limits: input.limits,
  };
  const canonicalDigest = `sha256:${hash(core)}`;
  return { ...core, brief_id: `morning-brief:v1:${hash({ generated_at: input.generated_at, canonical_digest: canonicalDigest })}`,
    canonical_digest: canonicalDigest };
}
function increment(counts: Map<MorningBriefOmissionReason, number>, reason: MorningBriefOmissionReason, amount: number): void {
  if (amount > 0) counts.set(reason, (counts.get(reason) ?? 0) + amount);
}
function capped(values: readonly MorningBriefItem[], maximum: number, counts: Map<MorningBriefOmissionReason, number>): readonly MorningBriefItem[] {
  increment(counts, "section_cap", Math.max(0, values.length - maximum));
  return values.slice(0, maximum);
}

export function generateMorningBrief(input: MorningBriefInput): MorningBriefResult {
  const counts = new Map<MorningBriefOmissionReason, number>();
  const eligible: MorningBriefRecord[] = [];
  for (const value of input.items) {
    const reason = omissionReason(value, input.generated_at);
    if (reason === null) eligible.push(value); else increment(counts, reason, 1);
  }
  const groups = new Map<string, MorningBriefRecord[]>();
  for (const value of eligible) groups.set(value.semantic_key, [...(groups.get(value.semantic_key) ?? []), value]);
  const merged = [...groups.values()].map(values => {
    const sources = uniqueSorted(values.flatMap(value => value.source_ids)).length;
    if (sources > input.limits.max_sources_per_item) increment(counts, "citation_cap", sources - input.limits.max_sources_per_item);
    return { source: [...values].sort(compareRecord)[0], output: item(values, input.limits.max_copy_bytes, input.limits.max_sources_per_item) };
  }).filter((value): value is { readonly source: MorningBriefRecord; readonly output: MorningBriefItem } => value.source !== undefined)
    .sort((left, right) => compareRecord(left.source, right.source));
  const needs = merged.filter(value => value.source.state === "actionable" && (value.source.owner_decision_required
    || value.source.priority.deadline_bucket === "today" || value.source.priority.deadline_bucket === "overdue")).map(value => value.output);
  const waiting = merged.filter(value => value.source.state === "blocked" || value.source.state === "deferred"
    || value.source.state === "dependency_waiting").map(value => value.output);
  const fyi = merged.filter(value => value.source.kind === "information" && value.source.state === "information").map(value => value.output);
  let sections: Sections = { needs: capped(needs, input.limits.max_needs_you_first, counts),
    waiting: capped(waiting, input.limits.max_waiting, counts), fyi: capped(fyi, input.limits.max_fyi, counts) };
  while (sections.needs.length + sections.waiting.length + sections.fyi.length > input.limits.max_total_items) {
    if (sections.fyi.length > 0) sections = { ...sections, fyi: sections.fyi.slice(0, -1) };
    else if (sections.waiting.length > 0) sections = { ...sections, waiting: sections.waiting.slice(0, -1) };
    else sections = { ...sections, needs: sections.needs.slice(0, -1) };
    increment(counts, "total_cap", 1);
  }
  let output = result(input, sections, counts);
  while (Buffer.byteLength(JSON.stringify(output), "utf8") > input.limits.max_total_bytes
    && sections.needs.length + sections.waiting.length + sections.fyi.length > 0) {
    if (sections.fyi.length > 0) sections = { ...sections, fyi: sections.fyi.slice(0, -1) };
    else if (sections.waiting.length > 0) sections = { ...sections, waiting: sections.waiting.slice(0, -1) };
    else sections = { ...sections, needs: sections.needs.slice(0, -1) };
    increment(counts, "total_cap", 1); output = result(input, sections, counts);
  }
  if (Buffer.byteLength(JSON.stringify(output), "utf8") > input.limits.max_total_bytes) throw new MorningBriefContractInvariantError();
  return output;
}
