import { canonicalize } from "./canonical.js";
import { kstLocalDate } from "./daily-loop-time.js";
import { array, citation, digest, fail, hash, instant, member, object, priority, privateText } from "./morning-brief-parse-values.js";
import type { MorningBriefItem, MorningBriefLimits } from "./morning-brief-types.js";

export type MorningSection = "needs_you_first" | "waiting" | "fyi";
export function briefStrings(value: unknown, maximum: number): readonly string[] {
  const strings = array(value, maximum).map(item => privateText(item));
  if (new Set(strings).size !== strings.length) return fail();
  return strings;
}
export function parseMorningBriefItem(value: unknown, limits: MorningBriefLimits): MorningBriefItem {
  const input = object(value, ["item_id", "recommendation_id", "action_id", "contributing_item_ids",
    "contributing_recommendation_ids", "contributing_action_ids", "source_ids", "citations", "copy",
    "observed_at", "valid_from", "valid_until", "fresh_until", "trust", "confidence", "owner_decision_required",
    "deadline", "priority", "provenance_digest", "canonical_digest"]);
  const item: MorningBriefItem = {
    item_id: privateText(input["item_id"]), recommendation_id: privateText(input["recommendation_id"]),
    action_id: privateText(input["action_id"]), contributing_item_ids: briefStrings(input["contributing_item_ids"], 256),
    contributing_recommendation_ids: briefStrings(input["contributing_recommendation_ids"], 256),
    contributing_action_ids: briefStrings(input["contributing_action_ids"], 256),
    source_ids: briefStrings(input["source_ids"], limits.max_sources_per_item),
    citations: array(input["citations"], limits.max_sources_per_item).map(citation),
    // UTF-8 truncation can end at a space in an otherwise validated input string.
    copy: privateText(input["copy"], limits.max_copy_bytes, true),
    observed_at: instant(input["observed_at"]), valid_from: instant(input["valid_from"]),
    valid_until: instant(input["valid_until"]), fresh_until: instant(input["fresh_until"]),
    trust: member(input["trust"], ["confirmed", "inferred"] as const),
    confidence: member(input["confidence"], ["low", "medium", "high"] as const),
    owner_decision_required: input["owner_decision_required"] === true ? true : input["owner_decision_required"] === false ? false : fail(),
    deadline: input["deadline"] === null ? null : instant(input["deadline"]), priority: priority(input["priority"]),
    provenance_digest: digest(input["provenance_digest"]), canonical_digest: digest(input["canonical_digest"]),
  };
  const core = Object.fromEntries(Object.entries(item).filter(([key]) => !["provenance_digest", "canonical_digest"].includes(key)));
  const provenance = { contributing_item_ids: item.contributing_item_ids,
    contributing_recommendation_ids: item.contributing_recommendation_ids, contributing_action_ids: item.contributing_action_ids,
    source_ids: item.source_ids, citations: item.citations, observed_at: item.observed_at,
    valid_from: item.valid_from, valid_until: item.valid_until, fresh_until: item.fresh_until };
  if (hash(core) !== item.canonical_digest || hash(provenance) !== item.provenance_digest
    || !/^brief-item:v1:[0-9a-f]{64}$/.test(item.item_id) || item.contributing_item_ids.length === 0
    || item.contributing_action_ids.length !== item.contributing_item_ids.length
    || item.contributing_recommendation_ids.length > item.contributing_item_ids.length
    || !item.contributing_recommendation_ids.includes(item.recommendation_id)
    || !item.contributing_action_ids.includes(item.action_id) || item.source_ids.length === 0
    || item.source_ids.some(id => !item.citations.some(link => link.source_id === id))
    || item.citations.some(link => !item.source_ids.includes(link.source_id))
    || new Set(item.citations.map(link => link.link_id)).size !== item.citations.length) return fail();
  return item;
}

export function assertMorningItemSection(item: MorningBriefItem, section: MorningSection, generatedAt: string): void {
  if (item.valid_from > item.observed_at || item.observed_at > generatedAt || item.valid_until <= generatedAt
    || item.fresh_until <= generatedAt || item.valid_until <= item.valid_from || item.fresh_until <= item.observed_at) return fail();
  if (section === "fyi" && (item.trust !== "confirmed" || item.owner_decision_required)) return fail();
  if (section === "waiting" && item.owner_decision_required) return fail();
  if (section === "needs_you_first") {
    if (!item.owner_decision_required && !["today", "overdue"].includes(item.priority.deadline_bucket)) return fail();
    if (item.priority.deadline_bucket === "today" && (item.deadline === null
      || kstLocalDate(new Date(item.deadline)) !== kstLocalDate(new Date(generatedAt)))) return fail();
  }
}

export function assertMorningItemIdentities(items: readonly MorningBriefItem[]): void {
  if (items.reduce((sum, item) => sum + item.contributing_item_ids.length, 0) > 256) return fail();
  const roles = new Map<string, string>();
  const links = new Map<string, string>();
  const add = (id: string, role: string, shared = false) => {
    const previous = roles.get(id);
    if (previous !== undefined && (!shared || previous !== role)) return fail();
    roles.set(id, role);
  };
  for (const item of items) {
    add(item.item_id, "output");
    // Derived checksums are validated above; their values are not source identifiers.
    for (const id of item.contributing_item_ids) add(id, "item");
    for (const id of item.contributing_action_ids) add(id, "action");
    for (const id of item.contributing_recommendation_ids) add(id, "recommendation", true);
    for (const id of item.source_ids) add(id, "source", true);
    for (const link of item.citations) {
      add(link.link_id, "link", true);
      const binding = canonicalize(link); const previous = links.get(link.link_id);
      if (previous !== undefined && previous !== binding) return fail();
      links.set(link.link_id, binding);
    }
  }
}
