import { createHash } from "node:crypto";
import { types } from "node:util";
import { canonicalize } from "./canonical.js";
import { PRIORITY_LEXICOGRAPHIC_POLICY } from "./priority-engine-contracts.js";
import { containsPrivateMetadata } from "./private-text.js";
import { NotificationIntentError, type DecisionCitation, type DecisionEvent, type DecisionQueueInput,
  type DecisionQueueRecord } from "./notification-intent-types.js";

type Input = Readonly<Record<string, unknown>>;
const RECORD_KEYS = ["semantic_key", "recommendation_id", "action_id", "context_id", "context_digest", "recommendation_digest",
  "evidence_digest", "identity_digest", "source_state", "trust", "confidence", "reversible", "title", "safety", "deadline",
  "created_at", "expires_at", "priority", "source_ids", "citations", "events", "provenance_digest", "record_digest"] as const;
const fail = (): never => { throw new NotificationIntentError("NOTIFICATION_INPUT_INVALID"); };
function object(value: unknown, keys: readonly string[]): Input {
  if (typeof value !== "object" || value === null || types.isProxy(value) || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype) return fail();
  const descriptors = Object.getOwnPropertyDescriptors(value); const own = Reflect.ownKeys(value);
  if (own.length !== keys.length || own.some(key => typeof key !== "string" || !keys.includes(key))) return fail();
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (descriptor === undefined || !descriptor.enumerable || descriptor.get !== undefined || descriptor.set !== undefined) return fail();
  }
  return Object.fromEntries(keys.map(key => [key, descriptors[key]?.value]));
}
function array(value: unknown, maximum: number): readonly unknown[] {
  if (typeof value !== "object" || value === null || types.isProxy(value) || !Array.isArray(value)
    || Object.getPrototypeOf(value) !== Array.prototype || value.length > maximum) return fail();
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
      const next = value.charCodeAt(index + 1); if (!Number.isFinite(next) || next < 0xdc00 || next > 0xdfff) return true; index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return true;
  }
  return false;
}
function text(value: unknown, maximum = 512): string {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value || value !== value.normalize("NFC")
    || hasUnpairedSurrogate(value) || Buffer.byteLength(value, "utf8") > maximum
    || [...value].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
    || containsPrivateMetadata(value)) return fail();
  return value;
}
function instant(value: unknown): string {
  const parsed = text(value, 32); const epoch = Date.parse(parsed);
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(parsed) || !Number.isFinite(epoch)
    || new Date(epoch).toISOString() !== parsed) return fail();
  return parsed;
}
function digest(value: unknown): string { const parsed = text(value, 71); return /^sha256:[0-9a-f]{64}$/.test(parsed) ? parsed : fail(); }
function member<const Values extends readonly string[]>(value: unknown, values: Values): Values[number] {
  if (typeof value !== "string") return fail(); return values.find(candidate => candidate === value) ?? fail();
}
function citation(value: unknown): DecisionCitation {
  const input = object(value, ["source_id", "evidence_ref", "evidence_digest", "observed_at", "fresh_until"]);
  const result = { source_id: text(input["source_id"]), evidence_ref: text(input["evidence_ref"]),
    evidence_digest: digest(input["evidence_digest"]), observed_at: instant(input["observed_at"]),
    fresh_until: instant(input["fresh_until"]) };
  if (result.observed_at >= result.fresh_until) return fail(); return result;
}
function event(value: unknown): DecisionEvent {
  const input = object(value, ["state", "occurred_at", "event_digest"]);
  return { state: member(input["state"], ["pending", "accepted", "rejected", "dismissed", "snoozed", "expired", "superseded"] as const),
    occurred_at: instant(input["occurred_at"]), event_digest: digest(input["event_digest"]) };
}
function priority(value: unknown): DecisionQueueRecord["priority"] {
  const input = object(value, ["owner_safety_gate", "customer_impact", "deadline_bucket", "dependency_blocking",
    "irreversible_risk", "effort_cost", "stable_identity"]);
  const owner = member(input["owner_safety_gate"], PRIORITY_LEXICOGRAPHIC_POLICY.owner_safety_gate);
  if (owner !== "owner_approval_required") return fail();
  return { owner_safety_gate: owner, customer_impact: member(input["customer_impact"], PRIORITY_LEXICOGRAPHIC_POLICY.customer_impact),
    deadline_bucket: member(input["deadline_bucket"], PRIORITY_LEXICOGRAPHIC_POLICY.deadline_bucket),
    dependency_blocking: member(input["dependency_blocking"], PRIORITY_LEXICOGRAPHIC_POLICY.dependency_blocking),
    irreversible_risk: member(input["irreversible_risk"], PRIORITY_LEXICOGRAPHIC_POLICY.irreversible_risk),
    effort_cost: member(input["effort_cost"], PRIORITY_LEXICOGRAPHIC_POLICY.effort_cost), stable_identity: text(input["stable_identity"]) };
}
const hash = (value: unknown): string => `sha256:${createHash("sha256").update(canonicalize(value)).digest("hex")}`;
function record(value: unknown): DecisionQueueRecord {
  const input = object(value, RECORD_KEYS); const sourceIds = array(input["source_ids"], 64).map(item => text(item));
  const citations = array(input["citations"], 128).map(citation); const events = array(input["events"], 32).map(event);
  const core = { semantic_key: text(input["semantic_key"]), recommendation_id: text(input["recommendation_id"]),
    action_id: text(input["action_id"]), context_id: text(input["context_id"]), context_digest: digest(input["context_digest"]),
    recommendation_digest: digest(input["recommendation_digest"]), evidence_digest: digest(input["evidence_digest"]),
    identity_digest: digest(input["identity_digest"]), source_state: member(input["source_state"],
      ["active", "stale", "conflicted", "deleted", "superseded", "corrupt", "untrusted"] as const),
    trust: member(input["trust"], ["confirmed", "untrusted"] as const), confidence: member(input["confidence"], ["low", "medium", "high"] as const),
    reversible: input["reversible"] === true ? true : input["reversible"] === false ? false : fail(), title: text(input["title"], 512),
    safety: member(input["safety"], ["standard", "critical"] as const), deadline: input["deadline"] === null ? null : instant(input["deadline"]),
    created_at: instant(input["created_at"]), expires_at: instant(input["expires_at"]), priority: priority(input["priority"]),
    source_ids: sourceIds, citations, events };
  const provenance = { recommendation_id: core.recommendation_id, action_id: core.action_id, context_id: core.context_id,
    context_digest: core.context_digest, recommendation_digest: core.recommendation_digest, evidence_digest: core.evidence_digest,
    identity_digest: core.identity_digest, source_ids: sourceIds, citations, events };
  const provenanceDigest = digest(input["provenance_digest"]); const recordDigest = digest(input["record_digest"]);
  if (hash(provenance) !== provenanceDigest || hash(core) !== recordDigest || core.created_at >= core.expires_at
    || events.length === 0 || events.some((item, index) => index > 0 && item.occurred_at < (events[index - 1]?.occurred_at ?? ""))
    || new Set(sourceIds).size !== sourceIds.length) return fail();
  return { ...core, provenance_digest: provenanceDigest, record_digest: recordDigest };
}
export function parseDecisionQueueInput(value: unknown): DecisionQueueInput {
  const input = object(value, ["schema_version", "generated_at", "items"]); if (input["schema_version"] !== 1) return fail();
  return { schema_version: 1, generated_at: instant(input["generated_at"]), items: array(input["items"], 256).map(record) };
}
