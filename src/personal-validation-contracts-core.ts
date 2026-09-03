import { canonicalize } from "./canonical.js";
import {
  CONTEXT_STATES,
  OBSERVATION_STATES,
  PERSONAL_LIST_ITEMS_MAX,
  PERSONAL_TEXT_BYTES_MAX,
  PERSONAL_TOTAL_BYTES_MAX,
  RECOMMENDATION_STATES,
  SENSITIVITY_TIERS,
  TRUST_LEVELS,
  type ContextId,
  type ContextPayloadV1,
  type ContextSnapshotV1,
  type ObservationEnvelopeV1,
  type ObservationId,
  type ObservationPayloadV1,
  type RecommendationActionV1,
  type RecommendationId,
  type RecommendationPayloadV1,
  type RecommendationV1,
  type SourceId,
} from "./personal-contracts.js";
import {
  invalid,
  record,
  closed,
  literal,
  text,
  nullableText,
  integer,
  digest,
  isUuidV7,
  prefixedId,
  sourceId,
  list,
  textList,
  json,
} from "./personal-validation-primitives.js";
import { parseBase, finish, common } from "./personal-validation-base.js";

export function parseObservationEnvelopeV1(value: unknown): ObservationEnvelopeV1 {
  let idSource: SourceId | undefined;
  const { input, base } = parseBase(value, (item) => {
    if (typeof item !== "string") return invalid();
    const marker = item.lastIndexOf(":");
    if (marker < 0 || !item.startsWith("obs:pos:v1:") || !isUuidV7(item.slice(marker + 1))) return invalid();
    idSource = sourceId(item.slice("obs:pos:v1:".length, marker));
    function branded(candidate: string): candidate is ObservationId {
      return candidate === item;
    }
    return branded(item) ? item : invalid();
  });
  if (idSource !== base.source.source_id) invalid();
  const p = record(input.payload);
  closed(p, ["kind", "subject", "value", "trust", "sensitivity", "cursor", "checkpoint", "content_digest", "state"]);
  const payload: ObservationPayloadV1 = {
    kind: text(p.kind, 128),
    subject: text(p.subject, 512),
    value: json(p.value),
    trust: literal(p.trust, TRUST_LEVELS),
    sensitivity: literal(p.sensitivity, SENSITIVITY_TIERS),
    cursor: nullableText(p.cursor),
    checkpoint: nullableText(p.checkpoint),
    content_digest: digest(p.content_digest),
    state: literal(p.state, OBSERVATION_STATES),
  };
  if (input.receipt !== null) invalid();
  return finish(common(base, payload, null));
}
export function parseContextSnapshotV1(value: unknown): ContextSnapshotV1 {
  const { input, base } = parseBase(value, (item) => prefixedId<ContextId>(item, "ctx:pos:v1:"));
  const p = record(input.payload);
  closed(p, [
    "purpose",
    "query",
    "included_observation_refs",
    "included_memory_refs",
    "excluded_refs",
    "pending_authority_refs",
    "conflicts",
    "omissions",
    "budgets",
    "state",
  ]);
  const budgets = record(p.budgets);
  closed(budgets, ["max_items", "max_excerpt_bytes", "max_total_bytes"]);
  const payload: ContextPayloadV1 = {
    purpose: text(p.purpose, 128),
    query: text(p.query),
    included_observation_refs: textList(p.included_observation_refs),
    included_memory_refs: textList(p.included_memory_refs),
    excluded_refs: textList(p.excluded_refs),
    pending_authority_refs: textList(p.pending_authority_refs),
    conflicts: textList(p.conflicts),
    omissions: textList(p.omissions),
    budgets: {
      max_items: integer(budgets.max_items, 1, PERSONAL_LIST_ITEMS_MAX),
      max_excerpt_bytes: integer(budgets.max_excerpt_bytes, 1, PERSONAL_TEXT_BYTES_MAX),
      max_total_bytes: integer(budgets.max_total_bytes, 1, PERSONAL_TOTAL_BYTES_MAX),
    },
    state: literal(p.state, CONTEXT_STATES),
  };
  const lists = [
    payload.included_observation_refs,
    payload.included_memory_refs,
    payload.excluded_refs,
    payload.pending_authority_refs,
    payload.conflicts,
    payload.omissions,
  ];
  const excerpts = [payload.query, ...payload.conflicts, ...payload.omissions];
  if (
    lists.reduce((count, items) => count + items.length, 0) > payload.budgets.max_items ||
    excerpts.some((item) => Buffer.byteLength(item, "utf8") > payload.budgets.max_excerpt_bytes) ||
    Buffer.byteLength(canonicalize(payload), "utf8") > payload.budgets.max_total_bytes ||
    input.receipt !== null
  )
    invalid();
  return finish(common(base, payload, null));
}
function recommendationAction(value: unknown): RecommendationActionV1 {
  const p = record(value);
  closed(p, ["rank", "title", "operation", "target_digest"]);
  return {
    rank: integer(p.rank, 1, PERSONAL_LIST_ITEMS_MAX),
    title: text(p.title, 512),
    operation: text(p.operation, 128),
    target_digest: digest(p.target_digest),
  };
}
export function parseRecommendationV1(value: unknown): RecommendationV1 {
  const { input, base } = parseBase(value, (item) => prefixedId<RecommendationId>(item, "rec:pos:v1:"));
  const p = record(input.payload);
  closed(p, ["context_id", "context_digest", "actions", "citations", "conflicts", "omissions", "confidence_basis", "state"]);
  const actions = list(p.actions, recommendationAction);
  if (actions.some((item, index) => item.rank !== index + 1)) invalid();
  const payload: RecommendationPayloadV1 = {
    context_id: prefixedId<ContextId>(p.context_id, "ctx:pos:v1:"),
    context_digest: digest(p.context_digest),
    actions,
    citations: textList(p.citations),
    conflicts: textList(p.conflicts),
    omissions: textList(p.omissions),
    confidence_basis: text(p.confidence_basis),
    state: literal(p.state, RECOMMENDATION_STATES),
  };
  if (input.receipt !== null) invalid();
  if (Date.parse(base.expires_at) < Date.parse(base.created_at)) invalid();
  return finish(common(base, payload, null));
}
