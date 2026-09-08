import { canonicalize } from "./canonical.js";
import { kstLocalDate } from "./daily-loop-time.js";
import {
  MORNING_BRIEF_EXTERNAL_STATES,
  type MorningBriefInput,
  type MorningBriefLimits,
  type MorningBriefRecord,
  type MorningBriefRecordState,
} from "./morning-brief-types.js";
import { array, citation, digest, fail, hash, instant, integer, member, object, priority, privateText } from "./morning-brief-parse-values.js";
export { MorningBriefContractError } from "./morning-brief-parse-values.js";

export const DEFAULT_MORNING_BRIEF_LIMITS: MorningBriefLimits = {
  max_needs_you_first: 5, max_waiting: 5, max_fyi: 8, max_total_items: 18,
  max_sources_per_item: 64, max_copy_bytes: 160, max_total_bytes: 32_768,
};
const RECORD_KEYS = [
  "item_id", "recommendation_id", "action_id", "semantic_key", "kind", "state", "copy", "source_ids", "citations",
  "observed_at", "valid_from", "valid_until", "fresh_until", "trust", "confidence", "owner_decision_required", "deadline",
  "priority", "provenance_digest", "canonical_digest",
] as const;
const STATES = [
  "actionable", "blocked", "deferred", "dependency_waiting", "information", "stale", "expired", "deleted", "corrupt",
  "untrusted", "conflicting", "unrelated", "insufficient_citation",
] as const;
function record(value: unknown): MorningBriefRecord {
  const input = object(value, RECORD_KEYS);
  const itemId = privateText(input["item_id"]); const recommendationId = privateText(input["recommendation_id"]);
  const actionId = privateText(input["action_id"]); const semanticKey = privateText(input["semantic_key"]);
  const kind = member(input["kind"], ["action", "information"] as const);
  const state = member(input["state"], STATES) satisfies MorningBriefRecordState;
  const copy = privateText(input["copy"], 4_096);
  const sources = array(input["source_ids"], 128).map(item => privateText(item));
  const parsedCitations = array(input["citations"], 128).map(citation);
  const observed = instant(input["observed_at"]); const validFrom = instant(input["valid_from"]);
  const validUntil = instant(input["valid_until"]); const freshUntil = instant(input["fresh_until"]);
  const trust = member(input["trust"], ["confirmed", "inferred", "untrusted"] as const);
  const confidence = member(input["confidence"], ["low", "medium", "high"] as const);
  const ownerRequired = input["owner_decision_required"] === true ? true : input["owner_decision_required"] === false ? false : fail();
  const deadline = input["deadline"] === null ? null : instant(input["deadline"]);
  const parsedPriority = priority(input["priority"]);
  if (Date.parse(validFrom) > Date.parse(observed) || Date.parse(validUntil) <= Date.parse(validFrom)
    || Date.parse(freshUntil) <= Date.parse(observed) || new Set(sources).size !== sources.length
    || parsedCitations.some(item => !sources.includes(item.source_id))) return fail();
  const payload = { item_id: itemId, recommendation_id: recommendationId, action_id: actionId, semantic_key: semanticKey,
    kind, state, copy, source_ids: sources, citations: parsedCitations, observed_at: observed, valid_from: validFrom,
    valid_until: validUntil, fresh_until: freshUntil, trust, confidence, owner_decision_required: ownerRequired, deadline,
    priority: parsedPriority };
  const provenance = { item_id: itemId, recommendation_id: recommendationId, action_id: actionId, source_ids: sources,
    citations: parsedCitations, observed_at: observed, valid_from: validFrom, valid_until: validUntil, fresh_until: freshUntil };
  const provenanceDigest = digest(input["provenance_digest"]); const canonicalDigest = digest(input["canonical_digest"]);
  if (hash(provenance) !== provenanceDigest || hash(payload) !== canonicalDigest) return fail();
  return { ...payload, provenance_digest: provenanceDigest, canonical_digest: canonicalDigest };
}
export function parseMorningBriefLimits(value: unknown): MorningBriefLimits {
  if (value === null) return DEFAULT_MORNING_BRIEF_LIMITS;
  const input = object(value, ["max_needs_you_first", "max_waiting", "max_fyi", "max_total_items", "max_sources_per_item",
    "max_copy_bytes", "max_total_bytes"]);
  const parsed = {
    max_needs_you_first: integer(input["max_needs_you_first"], 0, 5), max_waiting: integer(input["max_waiting"], 0, 5),
    max_fyi: integer(input["max_fyi"], 0, 8), max_total_items: integer(input["max_total_items"], 0, 18),
    max_sources_per_item: integer(input["max_sources_per_item"], 1, 64), max_copy_bytes: integer(input["max_copy_bytes"], 16, 160),
    max_total_bytes: integer(input["max_total_bytes"], 2_048, 32_768),
  };
  if (parsed.max_total_items > parsed.max_needs_you_first + parsed.max_waiting + parsed.max_fyi) return fail();
  return parsed;
}

function validIdentities(items: readonly MorningBriefRecord[]): boolean {
  const roles = new Map<string, string>();
  for (const semanticKey of new Set(items.map(item => item.semantic_key))) {
    roles.set(`brief-item:v1:${hash({ semantic_key: semanticKey }).slice(7)}`, "output");
  }
  const links = new Map<string, string>();
  const add = (value: string, role: string, shared = false): boolean => {
    const previous = roles.get(value);
    if (previous !== undefined && (!shared || previous !== role)) return false;
    roles.set(value, role); return true;
  };
  for (const item of items) {
    if (!add(item.item_id, "item") || !add(item.action_id, "action")
      || !add(item.provenance_digest, "provenance") || !add(item.canonical_digest, "canonical")
      || !add(item.recommendation_id, "recommendation", true)) return false;
    for (const source of item.source_ids) if (!add(source, "source", true)) return false;
    const recordLinks = new Set<string>();
    for (const citation of item.citations) {
      if (recordLinks.has(citation.link_id) || !add(citation.link_id, "link", true)) return false;
      recordLinks.add(citation.link_id);
      const binding = canonicalize(citation);
      const previous = links.get(citation.link_id);
      if (previous !== undefined && previous !== binding) return false;
      links.set(citation.link_id, binding);
    }
  }
  return true;
}

export function parseMorningBriefInput(value: unknown): MorningBriefInput {
  const input = object(value, ["schema_version", "generated_at", "context_readiness", "external_intelligence", "limits", "items"]);
  if (input["schema_version"] !== 1) return fail();
  const external = object(input["external_intelligence"], ["enabled", "state"]);
  const enabled = external["enabled"] === true ? true : external["enabled"] === false ? false : fail();
  const state = member(external["state"], MORNING_BRIEF_EXTERNAL_STATES);
  if ((!enabled && state !== "off") || (enabled && state === "off")) return fail();
  const generatedAt = instant(input["generated_at"]);
  const items = array(input["items"], 256).map(record);
  if (input["context_readiness"] === "no_data" && items.length > 0) return fail();
  for (const item of items) {
    const waiting = item.state === "blocked" || item.state === "deferred" || item.state === "dependency_waiting";
    if ((waiting && item.owner_decision_required) || (item.state === "actionable" && item.kind !== "action")
      || (item.state === "information" && (item.kind !== "information" || item.owner_decision_required))
      || (item.state === "actionable" && item.priority.deadline_bucket === "today"
        && (item.deadline === null
          || kstLocalDate(new Date(item.deadline)) !== kstLocalDate(new Date(generatedAt))))) return fail();
  }
  if (!validIdentities(items)) return fail();
  return { schema_version: 1, generated_at: generatedAt,
    context_readiness: member(input["context_readiness"], ["ready", "degraded", "no_data"] as const),
    external_intelligence: { enabled, state }, limits: parseMorningBriefLimits(input["limits"]), items };
}
