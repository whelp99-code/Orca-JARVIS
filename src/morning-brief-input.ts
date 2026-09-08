import { createHash } from "node:crypto";
import { types } from "node:util";
import { canonicalize } from "./canonical.js";
import {
  MORNING_BRIEF_EXTERNAL_STATES,
  type MorningBriefCitation,
  type MorningBriefInput,
  type MorningBriefLimits,
  type MorningBriefPriority,
  type MorningBriefRecord,
  type MorningBriefRecordState,
} from "./morning-brief-types.js";
import { PRIORITY_LEXICOGRAPHIC_POLICY } from "./priority-engine-contracts.js";
import { containsPrivateMetadata } from "./private-text.js";

export class MorningBriefContractError extends Error {
  readonly name = "MorningBriefContractError";
  constructor() { super("MORNING_BRIEF_INPUT_INVALID"); }
}

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
const fail = (): never => { throw new MorningBriefContractError(); };
type Input = Readonly<Record<string, unknown>>;
function object(value: unknown, keys: readonly string[]): Input {
  if (typeof value !== "object" || value === null || types.isProxy(value)) return fail();
  if (Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return fail();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const own = Reflect.ownKeys(value);
  if (own.length !== keys.length || own.some(key => typeof key !== "string" || !keys.includes(key))) return fail();
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (descriptor === undefined || !descriptor.enumerable || descriptor.get !== undefined || descriptor.set !== undefined) return fail();
  }
  return Object.fromEntries(keys.map(key => [key, descriptors[key]?.value]));
}
function array(value: unknown, maximum: number): readonly unknown[] {
  if (typeof value !== "object" || value === null || types.isProxy(value)) return fail();
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > maximum) return fail();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(value).length !== value.length + 1) return fail();
  return Array.from({ length: value.length }, (_, index) => {
    const descriptor = descriptors[String(index)];
    if (descriptor === undefined || !descriptor.enumerable || descriptor.get !== undefined || descriptor.set !== undefined) return fail();
    return descriptor.value;
  });
}
function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      if (index + 1 >= value.length) return true;
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return true;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return true;
  }
  return false;
}
function text(value: unknown, maximum = 512): string {
  if (typeof value !== "string" || value.trim() !== value || value.length === 0 || hasUnpairedSurrogate(value)
    || value !== value.normalize("NFC") || Buffer.byteLength(value, "utf8") > maximum
    || [...value].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) return fail();
  return value;
}
function privateText(value: unknown, maximum = 512): string {
  const parsed = text(value, maximum);
  return containsPrivateMetadata(parsed) ? fail() : parsed;
}
function instant(value: unknown): string {
  const parsed = text(value, 32);
  const milliseconds = Date.parse(parsed);
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(parsed)
    || !Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== parsed) return fail();
  return parsed;
}
function member<const Values extends readonly string[]>(value: unknown, values: Values): Values[number] {
  if (typeof value !== "string") return fail();
  return values.find(candidate => candidate === value) ?? fail();
}
function integer(value: unknown, minimum: number, maximum: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum) return fail();
  return value;
}
function digest(value: unknown): string {
  const parsed = text(value, 71);
  if (!/^sha256:[0-9a-f]{64}$/.test(parsed)) return fail();
  return parsed;
}
const hash = (value: unknown): string => `sha256:${createHash("sha256").update(canonicalize(value)).digest("hex")}`;
function citation(value: unknown): MorningBriefCitation {
  const input = object(value, ["link_id", "source_id", "evidence_ref"]);
  return { link_id: privateText(input["link_id"]), source_id: privateText(input["source_id"]),
    evidence_ref: privateText(input["evidence_ref"]) };
}
function priority(value: unknown): MorningBriefPriority {
  const input = object(value, ["owner_safety_gate", "customer_impact", "deadline_bucket", "dependency_blocking",
    "irreversible_risk", "effort_cost", "stable_identity"]);
  return {
    owner_safety_gate: member(input["owner_safety_gate"], PRIORITY_LEXICOGRAPHIC_POLICY.owner_safety_gate),
    customer_impact: member(input["customer_impact"], PRIORITY_LEXICOGRAPHIC_POLICY.customer_impact),
    deadline_bucket: member(input["deadline_bucket"], PRIORITY_LEXICOGRAPHIC_POLICY.deadline_bucket),
    dependency_blocking: member(input["dependency_blocking"], PRIORITY_LEXICOGRAPHIC_POLICY.dependency_blocking),
    irreversible_risk: member(input["irreversible_risk"], PRIORITY_LEXICOGRAPHIC_POLICY.irreversible_risk),
    effort_cost: member(input["effort_cost"], PRIORITY_LEXICOGRAPHIC_POLICY.effort_cost),
    stable_identity: privateText(input["stable_identity"]),
  };
}
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
function limits(value: unknown): MorningBriefLimits {
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
  for (const item of items) {
    const waiting = item.state === "blocked" || item.state === "deferred" || item.state === "dependency_waiting";
    if ((waiting && item.owner_decision_required) || (item.state === "actionable" && item.kind !== "action")
      || (item.state === "information" && (item.kind !== "information" || item.owner_decision_required))
      || (item.state === "actionable" && item.priority.deadline_bucket === "today"
        && (item.deadline === null || item.deadline.slice(0, 10) !== generatedAt.slice(0, 10)))) return fail();
  }
  if (!validIdentities(items)) return fail();
  return { schema_version: 1, generated_at: generatedAt,
    context_readiness: member(input["context_readiness"], ["ready", "degraded", "no_data"] as const),
    external_intelligence: { enabled, state }, limits: limits(input["limits"]), items };
}
