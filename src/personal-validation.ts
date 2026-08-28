import { createHash } from "node:crypto";
import { canonicalize } from "./canonical.js";
import {
  AUTHORITY_KINDS, CLIENT_KINDS, CONTEXT_STATES, DAILY_LOOP_PHASES, DAILY_LOOP_STATES, FRESHNESS_STATES, HOST_IDS,
  MEMORY_CANDIDATE_KINDS, MEMORY_OPERATIONS, MEMORY_STATES, NOTIFICATION_STATES, OBSERVATION_STATES,
  PERSONAL_CONTRACT_CANONICALIZATION_INVALID, PERSONAL_CONTRACT_INVALID, PERSONAL_CONTRACT_VERSION,
  PERSONAL_CONTRACT_VERSION_UNSUPPORTED, PERSONAL_LIST_ITEMS_MAX, PERSONAL_MAX_LIFETIME_MS, PERSONAL_TEXT_BYTES_MAX,
  PERSONAL_TOTAL_BYTES_MAX, PERSONAL_VALUE_DEPTH_MAX, PERSONAL_VALUE_KEYS_MAX, POLICY_DECISIONS, POLICY_REASON_CODES,
  RECOMMENDATION_STATES, REMOTE_APPROVAL_STATES, REMOTE_CHALLENGE_STATES, REMOTE_DECISIONS, REMOTE_PRINCIPAL_STATES,
  SENSITIVITY_TIERS, SOURCE_KINDS, SOURCE_PROVIDERS, TRUST_LEVELS,
  type ContextId, type ContextPayloadV1, type ContextSnapshotV1, type CorrelationId, type DailyLoopPayloadV1,
  type DailyLoopRunId, type DailyLoopRunV1, type Evidence, type EvidenceId, type FamilyReceipt, type Freshness,
  type IdempotencyKey, type JsonValue, type MemoryCandidateId, type MemoryCandidatePayloadV1, type MemoryCandidateV1,
  type MemoryOutboxId, type MemoryOutboxPayloadV1, type MemoryOutboxV1, type NotificationIntentId,
  type NotificationIntentV1, type NotificationPayloadV1, type ObservationEnvelopeV1, type ObservationId,
  type ObservationPayloadV1, type PersonalContractV1, type PersonalEnvelopeV1, type PolicyDecision,
  type RecommendationActionV1, type RecommendationId, type RecommendationPayloadV1, type RecommendationV1,
  type RemoteApprovalPayloadV1, type RemoteApprovalReceiptId, type RemoteApprovalReceiptV1, type RemoteChallengeId,
  type RemoteChallengePayloadV1, type RemoteChallengeV1, type RemotePrincipalId, type RemotePrincipalPayloadV1,
  type RemotePrincipalV1, type Sha256Digest, type SourceId, type SourceMetadata, type UtcTimestamp,
} from "./personal-contracts.js";

export class PersonalContractError extends Error {
  readonly name = "PersonalContractError";
  constructor(readonly code: typeof PERSONAL_CONTRACT_INVALID | typeof PERSONAL_CONTRACT_VERSION_UNSUPPORTED | typeof PERSONAL_CONTRACT_CANONICALIZATION_INVALID) { super(code); }
}
const invalid = (): never => { throw new PersonalContractError(PERSONAL_CONTRACT_INVALID); };
const parsedContracts = new WeakSet<object>();
const ENVELOPE_KEYS = ["schema_version", "id", "created_at", "observed_at", "valid_at", "source", "authority", "freshness", "expires_at", "idempotency_key", "correlation_id", "causation_id", "payload", "policy_decision", "evidence", "receipt"] as const;
const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const SOURCE_ID = /^src:pos:v1:([a-z][a-z0-9-]{1,31}):([a-z0-9][a-z0-9-]{0,63})$/;
const TIMESTAMP = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;
const CORRELATION = /^corr:pos:v1:[0-9a-f-]{36}$/;
const IDEMPOTENCY = /^idem:pos:v1:[a-z0-9][a-z0-9-]{0,63}:[0-9a-f]{64}$/;

type ParsedBase<Id> = Omit<PersonalEnvelopeV1<Id, never, never>, "payload" | "receipt">;
type IdParser<Id> = (value: unknown) => Id;
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value) || Object.getPrototypeOf(value) !== Object.prototype) return invalid();
  if (Reflect.ownKeys(value).some(key => typeof key !== "string")) return invalid();
  return value;
}
function closed(value: Record<string, unknown>, keys: readonly string[]): void {
  const actual = Object.keys(value); if (actual.length !== keys.length || actual.some(key => !keys.includes(key))) invalid();
}
function literal<const Values extends readonly string[]>(value: unknown, values: Values): Values[number] {
  if (typeof value !== "string") return invalid(); const match = values.find(candidate => candidate === value); return match ?? invalid();
}
function text(value: unknown, maximum = PERSONAL_TEXT_BYTES_MAX): string {
  if (typeof value !== "string" || value !== value.normalize("NFC") || value.trim().length === 0 || [...value].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127) || Buffer.byteLength(value, "utf8") > maximum) return invalid(); return value;
}
function nullableText(value: unknown): string | null { return value === null ? null : text(value); }
function integer(value: unknown, minimum: number, maximum: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum) return invalid(); return value;
}
function booleanTrue(value: unknown): true { if (value !== true) return invalid(); return true; }
function isDigest(value: unknown): value is Sha256Digest { return typeof value === "string" && DIGEST.test(value); }
function digest(value: unknown): Sha256Digest { return isDigest(value) ? value : invalid(); }
function nullableDigest(value: unknown): Sha256Digest | null { return value === null ? null : digest(value); }
function isTimestamp(value: unknown): value is UtcTimestamp { return typeof value === "string" && TIMESTAMP.test(value) && Number.isFinite(Date.parse(value)) && new Date(Date.parse(value)).toISOString() === value; }
function timestamp(value: unknown): UtcTimestamp { return isTimestamp(value) ? value : invalid(); }
function nullableTimestamp(value: unknown): UtcTimestamp | null { return value === null ? null : timestamp(value); }
function isUuidV7(value: string): boolean { return UUID_V7.test(value); }
function prefixedId<Name>(value: unknown, prefix: string): Name {
  if (typeof value !== "string" || !value.startsWith(prefix) || !isUuidV7(value.slice(prefix.length))) return invalid();
  function branded(candidate: string): candidate is string & Name { return candidate === value; }
  return branded(value) ? value : invalid();
}
function sourceId(value: unknown): SourceId {
  if (typeof value !== "string") return invalid(); const match = SOURCE_ID.exec(value); const provider = match?.[1];
  if (provider === undefined || !SOURCE_PROVIDERS.some(candidate => candidate === provider)) return invalid();
  function branded(candidate: string): candidate is SourceId { return SOURCE_ID.test(candidate); } return branded(value) ? value : invalid();
}
function correlation(value: unknown): CorrelationId {
  if (typeof value !== "string" || !CORRELATION.test(value) || !isUuidV7(value.slice("corr:pos:v1:".length))) return invalid();
  function branded(candidate: string): candidate is CorrelationId { return CORRELATION.test(candidate); } return branded(value) ? value : invalid();
}
function idempotency(value: unknown): IdempotencyKey {
  if (typeof value !== "string" || !IDEMPOTENCY.test(value)) return invalid();
  function branded(candidate: string): candidate is IdempotencyKey { return IDEMPOTENCY.test(candidate); } return branded(value) ? value : invalid();
}
function evidenceId(value: unknown): EvidenceId { return prefixedId<EvidenceId>(value, "evi:pos:v1:"); }
function list<T>(value: unknown, parse: (item: unknown) => T, unique = true): readonly T[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > PERSONAL_LIST_ITEMS_MAX) return invalid();
  const result = value.map(parse); if (unique && new Set(result.map(item => canonicalize(item))).size !== result.length) invalid(); return result;
}
function textList(value: unknown): readonly string[] { return list(value, item => text(item)); }
function json(value: unknown, depth = 0): JsonValue {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") return text(value);
  if (typeof value === "number") { if (!Number.isFinite(value) || !Number.isSafeInteger(value)) return invalid(); return value; }
  if (Array.isArray(value)) { if (Object.getPrototypeOf(value) !== Array.prototype || value.length > PERSONAL_LIST_ITEMS_MAX || depth >= PERSONAL_VALUE_DEPTH_MAX) return invalid(); return value.map(item => json(item, depth + 1)); }
  const input = record(value); const keys = Object.keys(input); if (depth >= PERSONAL_VALUE_DEPTH_MAX || keys.length > PERSONAL_VALUE_KEYS_MAX || keys.some(key => ["__proto__", "authority", "constructor", "identity", "instructions", "policy", "prototype", "receipt", "source", "tool_scope"].includes(key))) return invalid();
  return Object.fromEntries(keys.map(key => [text(key, 128), json(input[key], depth + 1)]));
}
function parseSource(value: unknown): SourceMetadata {
  const input = record(value); closed(input, ["source_id", "source_kind", "host_id", "source_version", "evidence_ref"]); const id = sourceId(input.source_id); const kind = literal(input.source_kind, SOURCE_KINDS); const host = literal(input.host_id, HOST_IDS); const provider = literal(id.split(":")[3], SOURCE_PROVIDERS);
  let expectedKind: (typeof SOURCE_KINDS)[number];
  switch (provider) {
    case "jarvis": expectedKind = "authority"; break;
    case "orca": case "portfolio": case "calendar": case "mail": case "messenger": expectedKind = "live_adapter"; break;
    case "task-timeline": expectedKind = "timeline"; break;
    case "second-brain": expectedKind = "second_brain"; break;
    case "gateway": expectedKind = "gateway"; break;
    case "mac-client": case "phone-client": expectedKind = "client"; break;
    default: { const exhaustive: never = provider; return exhaustive; }
  }
  const client = provider === "mac-client" || provider === "phone-client"; if (kind !== expectedKind || (client && host !== `host:pos:${provider}`) || (!client && (host === "host:pos:mac-client" || host === "host:pos:phone-client"))) invalid();
  if ((provider === "second-brain" && host !== "host:pos:linux-second-brain") || (provider !== "second-brain" && !client && host !== "host:pos:linux-control-plane")) invalid();
  return { source_id: id, source_kind: kind, host_id: host, source_version: text(input.source_version, 128), evidence_ref: text(input.evidence_ref, 512) };
}
function parseAuthority(value: unknown): { readonly authority_kind: "none"; readonly principal_id: null; readonly request_id: null; readonly receipt_id: null } {
  const input = record(value); closed(input, ["authority_kind", "principal_id", "request_id", "receipt_id"]); literal(input.authority_kind, AUTHORITY_KINDS);
  if (input.authority_kind !== "none" || input.principal_id !== null || input.request_id !== null || input.receipt_id !== null) invalid();
  return { authority_kind: "none", principal_id: null, request_id: null, receipt_id: null };
}
function parseFreshness(value: unknown): Freshness {
  const input = record(value); closed(input, ["state", "checked_at", "fresh_until"]); return { state: literal(input.state, FRESHNESS_STATES), checked_at: timestamp(input.checked_at), fresh_until: timestamp(input.fresh_until) };
}
function parsePolicy(value: unknown): PolicyDecision {
  const input = record(value); closed(input, ["decision", "policy_version", "reason_codes"]); return { decision: literal(input.decision, POLICY_DECISIONS), policy_version: text(input.policy_version, 128), reason_codes: list(input.reason_codes, item => literal(item, POLICY_REASON_CODES)) };
}
function parseEvidence(value: unknown): Evidence {
  const input = record(value); closed(input, ["evidence_id", "digest", "kind", "source_id", "observed_at"]); return { evidence_id: evidenceId(input.evidence_id), digest: digest(input.digest), kind: text(input.kind, 128), source_id: sourceId(input.source_id), observed_at: timestamp(input.observed_at) };
}
function parseReceipt(value: unknown): FamilyReceipt {
  const input = record(value); closed(input, ["receipt_kind", "request_id", "receipt_id", "command_digest", "principal_id", "expires_at"]);
  return { receipt_kind: literal(input.receipt_kind, ["owner_enrollment", "owner_revocation", "confirmation", "control_translation", "delivery"] as const), request_id: text(input.request_id, 128), receipt_id: text(input.receipt_id, 128), command_digest: digest(input.command_digest), principal_id: text(input.principal_id, 128), expires_at: timestamp(input.expires_at) };
}
function parseBase<Id>(value: unknown, parseId: IdParser<Id>): { readonly input: Record<string, unknown>; readonly base: ParsedBase<Id> } {
  const input = record(value); if (input.schema_version !== PERSONAL_CONTRACT_VERSION) throw new PersonalContractError(PERSONAL_CONTRACT_VERSION_UNSUPPORTED); closed(input, ENVELOPE_KEYS);
  const created = timestamp(input.created_at); const observed = timestamp(input.observed_at); const valid = timestamp(input.valid_at); const expires = timestamp(input.expires_at); const fresh = parseFreshness(input.freshness); const source = parseSource(input.source); const evidence = list(input.evidence, parseEvidence);
  const createdMs = Date.parse(created); if (Date.parse(observed) > createdMs || Date.parse(valid) > createdMs || Date.parse(fresh.checked_at) < Date.parse(observed) || Date.parse(fresh.fresh_until) < Date.parse(fresh.checked_at) || Date.parse(fresh.fresh_until) >= Date.parse(expires) || Date.parse(expires) <= createdMs || Date.parse(expires) - createdMs > PERSONAL_MAX_LIFETIME_MS || evidence.some(item => item.source_id !== source.source_id || Date.parse(item.observed_at) > createdMs)) invalid();
  return { input, base: { schema_version: PERSONAL_CONTRACT_VERSION, id: parseId(input.id), created_at: created, observed_at: observed, valid_at: valid, source, authority: parseAuthority(input.authority), freshness: fresh, expires_at: expires, idempotency_key: idempotency(input.idempotency_key), correlation_id: correlation(input.correlation_id), causation_id: input.causation_id === null ? null : correlation(input.causation_id), policy_decision: parsePolicy(input.policy_decision), evidence } };
}
function finish<T extends PersonalContractV1>(value: T): T {
  if (Buffer.byteLength(canonicalize(value), "utf8") > PERSONAL_TOTAL_BYTES_MAX) invalid();
  const freeze = (item: unknown): void => { if (typeof item !== "object" || item === null || Object.isFrozen(item)) return; for (const key of Reflect.ownKeys(item)) freeze(Reflect.get(item, key)); Object.freeze(item); };
  freeze(value); parsedContracts.add(value); return value;
}
function nullableFamilyId<Id>(value: unknown, parse: IdParser<Id>): Id | null { return value === null ? null : parse(value); }
function common<Id, Payload, Receipt>(base: ParsedBase<Id>, payload: Payload, receipt: Receipt): PersonalEnvelopeV1<Id, Payload, Receipt> { return { ...base, payload, receipt }; }

export function parseObservationEnvelopeV1(value: unknown): ObservationEnvelopeV1 {
  let idSource: SourceId | undefined;
  const { input, base } = parseBase(value, item => { if (typeof item !== "string") return invalid(); const marker = item.lastIndexOf(":"); if (marker < 0 || !item.startsWith("obs:pos:v1:") || !isUuidV7(item.slice(marker + 1))) return invalid(); idSource = sourceId(item.slice("obs:pos:v1:".length, marker)); function branded(candidate: string): candidate is ObservationId { return candidate === item; } return branded(item) ? item : invalid(); });
  if (idSource !== base.source.source_id) invalid(); const p = record(input.payload); closed(p, ["kind", "subject", "value", "trust", "sensitivity", "cursor", "checkpoint", "content_digest", "state"]);
  const payload: ObservationPayloadV1 = { kind: text(p.kind, 128), subject: text(p.subject, 512), value: json(p.value), trust: literal(p.trust, TRUST_LEVELS), sensitivity: literal(p.sensitivity, SENSITIVITY_TIERS), cursor: nullableText(p.cursor), checkpoint: nullableText(p.checkpoint), content_digest: digest(p.content_digest), state: literal(p.state, OBSERVATION_STATES) };
  if (input.receipt !== null) invalid(); return finish(common(base, payload, null));
}
export function parseContextSnapshotV1(value: unknown): ContextSnapshotV1 {
  const { input, base } = parseBase(value, item => prefixedId<ContextId>(item, "ctx:pos:v1:")); const p = record(input.payload); closed(p, ["purpose", "query", "included_observation_refs", "included_memory_refs", "excluded_refs", "pending_authority_refs", "conflicts", "omissions", "budgets", "state"]); const budgets = record(p.budgets); closed(budgets, ["max_items", "max_excerpt_bytes", "max_total_bytes"]);
  const payload: ContextPayloadV1 = { purpose: text(p.purpose, 128), query: text(p.query), included_observation_refs: textList(p.included_observation_refs), included_memory_refs: textList(p.included_memory_refs), excluded_refs: textList(p.excluded_refs), pending_authority_refs: textList(p.pending_authority_refs), conflicts: textList(p.conflicts), omissions: textList(p.omissions), budgets: { max_items: integer(budgets.max_items, 1, PERSONAL_LIST_ITEMS_MAX), max_excerpt_bytes: integer(budgets.max_excerpt_bytes, 1, PERSONAL_TEXT_BYTES_MAX), max_total_bytes: integer(budgets.max_total_bytes, 1, PERSONAL_TOTAL_BYTES_MAX) }, state: literal(p.state, CONTEXT_STATES) };
  if (input.receipt !== null) invalid(); return finish(common(base, payload, null));
}
function recommendationAction(value: unknown): RecommendationActionV1 { const p = record(value); closed(p, ["rank", "title", "operation", "target_digest"]); return { rank: integer(p.rank, 1, PERSONAL_LIST_ITEMS_MAX), title: text(p.title, 512), operation: text(p.operation, 128), target_digest: digest(p.target_digest) }; }
export function parseRecommendationV1(value: unknown): RecommendationV1 {
  const { input, base } = parseBase(value, item => prefixedId<RecommendationId>(item, "rec:pos:v1:")); const p = record(input.payload); closed(p, ["context_id", "context_digest", "actions", "citations", "conflicts", "omissions", "confidence_basis", "state"]); const actions = list(p.actions, recommendationAction); if (actions.some((item, index) => item.rank !== index + 1)) invalid();
  const payload: RecommendationPayloadV1 = { context_id: prefixedId<ContextId>(p.context_id, "ctx:pos:v1:"), context_digest: digest(p.context_digest), actions, citations: textList(p.citations), conflicts: textList(p.conflicts), omissions: textList(p.omissions), confidence_basis: text(p.confidence_basis), state: literal(p.state, RECOMMENDATION_STATES) };
  if (input.receipt !== null) invalid(); if (Date.parse(base.expires_at) < Date.parse(base.created_at)) invalid(); return finish(common(base, payload, null));
}
export function parseDailyLoopRunV1(value: unknown): DailyLoopRunV1 {
  const { input, base } = parseBase(value, item => prefixedId<DailyLoopRunId>(item, "wfr:pos:v1:")); const p = record(input.payload); closed(p, ["loop_date", "phase", "state", "recommendation_id", "context_id", "request_id", "lease_owner", "lease_fence", "lease_expires_at", "verification_refs"]); const loopDate = text(p.loop_date, 10); if (!/^\d{4}-\d\d-\d\d$/.test(loopDate) || new Date(`${loopDate}T00:00:00.000Z`).toISOString().slice(0, 10) !== loopDate) invalid(); const leaseExpires = nullableTimestamp(p.lease_expires_at); const leaseOwner = nullableText(p.lease_owner); const fence = integer(p.lease_fence, 0, 2_147_483_647); if ((leaseOwner === null) !== (leaseExpires === null) || (leaseOwner === null && fence !== 0) || (leaseExpires !== null && Date.parse(leaseExpires) > Date.parse(base.expires_at))) invalid();
  const payload: DailyLoopPayloadV1 = { loop_date: loopDate, phase: literal(p.phase, DAILY_LOOP_PHASES), state: literal(p.state, DAILY_LOOP_STATES), recommendation_id: nullableFamilyId(p.recommendation_id, item => prefixedId<RecommendationId>(item, "rec:pos:v1:")), context_id: nullableFamilyId(p.context_id, item => prefixedId<ContextId>(item, "ctx:pos:v1:")), request_id: nullableText(p.request_id), lease_owner: leaseOwner, lease_fence: fence, lease_expires_at: leaseExpires, verification_refs: textList(p.verification_refs) };
  if (input.receipt !== null) invalid(); return finish(common(base, payload, null));
}
export function parseNotificationIntentV1(value: unknown): NotificationIntentV1 {
  const { input, base } = parseBase(value, item => prefixedId<NotificationIntentId>(item, "ntf:pos:v1:")); const p = record(input.payload); closed(p, ["title", "summary", "alert_class", "urgency", "quiet_hours_decision", "channel", "deep_link", "dedup_key", "state"]);
  const payload: NotificationPayloadV1 = { title: text(p.title, 256), summary: text(p.summary, 1024), alert_class: text(p.alert_class, 128), urgency: literal(p.urgency, ["low", "normal", "high", "critical"] as const), quiet_hours_decision: literal(p.quiet_hours_decision, ["deliver", "defer", "suppress"] as const), channel: literal(p.channel, ["in_app", "mac_native", "phone_web"] as const), deep_link: text(p.deep_link, 512), dedup_key: text(p.dedup_key, 256), state: literal(p.state, NOTIFICATION_STATES) };
  if (!payload.deep_link.startsWith("jarvis://") || input.receipt !== null) invalid(); return finish(common(base, payload, null));
}
export function parseMemoryCandidateV1(value: unknown): MemoryCandidateV1 {
  const { input, base } = parseBase(value, item => prefixedId<MemoryCandidateId>(item, "memcand:pos:v1:")); const p = record(input.payload); closed(p, ["kind", "content", "content_digest", "target_digest", "sensitivity", "confidence", "confirmation_state", "confirmation_refs", "verification_refs", "state"]); const kind = literal(p.kind, MEMORY_CANDIDATE_KINDS); const content = nullableText(p.content); const contentDigest = nullableDigest(p.content_digest); const targetDigest = nullableDigest(p.target_digest); if ((kind === "forget" && targetDigest === null) || (kind !== "forget" && (content === null || contentDigest === null))) invalid();
  const payload: MemoryCandidatePayloadV1 = { kind, content, content_digest: contentDigest, target_digest: targetDigest, sensitivity: literal(p.sensitivity, SENSITIVITY_TIERS), confidence: literal(p.confidence, ["verified", "confirmed", "inferred"] as const), confirmation_state: literal(p.confirmation_state, ["not_required", "required", "confirmed", "rejected"] as const), confirmation_refs: textList(p.confirmation_refs), verification_refs: textList(p.verification_refs), state: literal(p.state, MEMORY_STATES) };
  return finish(common(base, payload, input.receipt === null ? null : parseReceipt(input.receipt)));
}
export function parseMemoryOutboxV1(value: unknown): MemoryOutboxV1 {
  const { input, base } = parseBase(value, item => prefixedId<MemoryOutboxId>(item, "memout:pos:v1:")); const p = record(input.payload); closed(p, ["candidate_id", "candidate_digest", "operation", "provider_version", "attempt", "fence", "expected_artifact_selector", "expected_artifact_digest", "state"]);
  const payload: MemoryOutboxPayloadV1 = { candidate_id: prefixedId<MemoryCandidateId>(p.candidate_id, "memcand:pos:v1:"), candidate_digest: digest(p.candidate_digest), operation: literal(p.operation, MEMORY_OPERATIONS), provider_version: text(p.provider_version, 128), attempt: integer(p.attempt, 1, 1_000_000), fence: integer(p.fence, 1, 2_147_483_647), expected_artifact_selector: text(p.expected_artifact_selector, 512), expected_artifact_digest: digest(p.expected_artifact_digest), state: literal(p.state, MEMORY_STATES) };
  return finish(common(base, payload, input.receipt === null ? null : parseReceipt(input.receipt)));
}
export function parseRemotePrincipalV1(value: unknown): RemotePrincipalV1 {
  const { input, base } = parseBase(value, item => prefixedId<RemotePrincipalId>(item, "rpr:pos:v1:")); const p = record(input.payload); closed(p, ["subject", "client_kinds", "credential_id", "public_key_digest", "sign_count", "state"]);
  const payload: RemotePrincipalPayloadV1 = { subject: text(p.subject, 128), client_kinds: list(p.client_kinds, item => literal(item, CLIENT_KINDS)), credential_id: text(p.credential_id, 512), public_key_digest: digest(p.public_key_digest), sign_count: integer(p.sign_count, 0, Number.MAX_SAFE_INTEGER), state: literal(p.state, REMOTE_PRINCIPAL_STATES) };
  const receipt = input.receipt === null ? null : parseReceipt(input.receipt); if (payload.state === "active" && receipt === null) invalid(); return finish(common(base, payload, receipt));
}
function parseGatewayBase<Id>(value: unknown, parseId: IdParser<Id>): { readonly input: Record<string, unknown>; readonly base: ParsedBase<Id> } { const parsed = parseBase(value, parseId); if (parsed.base.source.source_kind !== "gateway" || !parsed.base.source.source_id.startsWith("src:pos:v1:gateway:")) invalid(); return parsed; }
export function parseRemoteChallengeV1(value: unknown): RemoteChallengeV1 {
  const { input, base } = parseGatewayBase(value, item => prefixedId<RemoteChallengeId>(item, "rch:pos:v1:")); const p = record(input.payload); closed(p, ["principal_id", "session_id", "command_digest", "target_digest", "args_digest", "nonce", "origin", "rp_id", "state"]); const origin = text(p.origin, 512); const rp = text(p.rp_id, 253); if (origin !== `https://${rp}` || !rp.endsWith(".tailnet")) invalid();
  const payload: RemoteChallengePayloadV1 = { principal_id: prefixedId<RemotePrincipalId>(p.principal_id, "rpr:pos:v1:"), session_id: text(p.session_id, 128), command_digest: digest(p.command_digest), target_digest: digest(p.target_digest), args_digest: digest(p.args_digest), nonce: text(p.nonce, 256), origin, rp_id: rp, state: literal(p.state, REMOTE_CHALLENGE_STATES) };
  if (input.receipt !== null) invalid(); return finish(common(base, payload, null));
}
export function parseRemoteApprovalReceiptV1(value: unknown): RemoteApprovalReceiptV1 {
  const { input, base } = parseGatewayBase(value, item => prefixedId<RemoteApprovalReceiptId>(item, "rap:pos:v1:")); const p = record(input.payload); closed(p, ["challenge_id", "principal_id", "session_id", "credential_id", "assertion_digest", "command_digest", "decision", "single_use", "state"]);
  const payload: RemoteApprovalPayloadV1 = { challenge_id: prefixedId<RemoteChallengeId>(p.challenge_id, "rch:pos:v1:"), principal_id: prefixedId<RemotePrincipalId>(p.principal_id, "rpr:pos:v1:"), session_id: text(p.session_id, 128), credential_id: text(p.credential_id, 512), assertion_digest: digest(p.assertion_digest), command_digest: digest(p.command_digest), decision: literal(p.decision, REMOTE_DECISIONS), single_use: booleanTrue(p.single_use), state: literal(p.state, REMOTE_APPROVAL_STATES) };
  const receipt = parseReceipt(input.receipt); if (receipt.receipt_kind !== "control_translation" || receipt.command_digest !== payload.command_digest || Date.parse(receipt.expires_at) > Date.parse(base.expires_at)) invalid(); return finish(common(base, payload, receipt));
}
export function canonicalPersonalContractJson(value: PersonalContractV1): string { if (!parsedContracts.has(value)) throw new PersonalContractError(PERSONAL_CONTRACT_CANONICALIZATION_INVALID); return canonicalize(value); }
export function canonicalPersonalContractHash(value: PersonalContractV1): Sha256Digest { const result = `sha256:${createHash("sha256").update(canonicalPersonalContractJson(value)).digest("hex")}`; return digest(result); }
