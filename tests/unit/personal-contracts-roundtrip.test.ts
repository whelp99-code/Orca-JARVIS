import { describe, expect, it } from "vitest";
import { canonicalize } from "../../src/canonical.js";
import {
  canonicalPersonalContractHash,
  canonicalPersonalContractJson,
  parseContextSnapshotV1,
  parseDailyLoopRunV1,
  parseMemoryCandidateV1,
  parseMemoryOutboxV1,
  parseNotificationIntentV1,
  parseObservationEnvelopeV1,
  parseRecommendationV1,
  parseRemoteApprovalReceiptV1,
  parseRemoteChallengeV1,
  parseRemotePrincipalV1,
} from "../../src/personal-validation.js";

const uuid = "018f0d4e-7b2a-7cc1-8a2b-3c4d5e6f7081";
const digest = (character: string) => `sha256:${character.repeat(64)}`;
const source = { source_id: "src:pos:v1:jarvis:primary", source_kind: "authority", host_id: "host:pos:linux-control-plane", source_version: "jarvis-v1", evidence_ref: "ref:authority:1" };
const gatewaySource = { source_id: "src:pos:v1:gateway:primary", source_kind: "gateway", host_id: "host:pos:linux-control-plane", source_version: "gateway-v1", evidence_ref: "ref:gateway:1" };
const authority = { authority_kind: "none", principal_id: null, request_id: null, receipt_id: null };
const freshness = { state: "fresh", checked_at: "2026-08-28T10:00:00.000Z", fresh_until: "2026-08-28T11:00:00.000Z" };
const policy_decision = { decision: "allow", policy_version: "personal-os-policy-v1", reason_codes: ["POLICY_SATISFIED"] };
const evidence = [{ evidence_id: `evi:pos:v1:${uuid}`, digest: digest("a"), kind: "authority", source_id: source.source_id, observed_at: "2026-08-28T09:59:00.000Z" }];

function envelope(id: string, payload: Record<string, unknown>, receipt: Record<string, unknown> | null = null) {
  return { schema_version: 1, id, created_at: "2026-08-28T10:00:00.000Z", observed_at: "2026-08-28T09:59:00.000Z", valid_at: "2026-08-28T09:59:00.000Z", source, authority, freshness, expires_at: "2026-08-28T12:00:00.000Z", idempotency_key: `idem:pos:v1:test:${"b".repeat(64)}`, correlation_id: `corr:pos:v1:${uuid}`, causation_id: null, payload, policy_decision, evidence, receipt };
}

const cases = [
  ["observation", parseObservationEnvelopeV1, envelope(`obs:pos:v1:${source.source_id}:${uuid}`, { kind: "work_status", subject: "task:9", value: { state: "running", text: "payload is inert" }, trust: "verified", sensitivity: "personal", cursor: "cursor:1", checkpoint: "checkpoint:1", content_digest: digest("c"), state: "fresh" })],
  ["context", parseContextSnapshotV1, envelope(`ctx:pos:v1:${uuid}`, { purpose: "daily_prioritization", query: "What now?", included_observation_refs: [`obs:pos:v1:${source.source_id}:${uuid}`], included_memory_refs: ["sid:principle:1"], excluded_refs: [], pending_authority_refs: ["request:1"], conflicts: [], omissions: ["calendar unavailable"], budgets: { max_items: 16, max_excerpt_bytes: 1024, max_total_bytes: 8192 }, state: "sufficient" })],
  ["recommendation", parseRecommendationV1, envelope(`rec:pos:v1:${uuid}`, { context_id: `ctx:pos:v1:${uuid}`, context_digest: digest("d"), actions: [{ rank: 1, title: "Finish parser", operation: "continue_work", target_digest: digest("e") }], citations: [`evi:pos:v1:${uuid}`], conflicts: [], omissions: [], confidence_basis: "fresh verified work evidence", state: "eligible" })],
  ["daily loop", parseDailyLoopRunV1, envelope(`wfr:pos:v1:${uuid}`, { loop_date: "2026-08-28", phase: "morning", state: "planned", recommendation_id: `rec:pos:v1:${uuid}`, context_id: `ctx:pos:v1:${uuid}`, request_id: null, lease_owner: null, lease_fence: 0, lease_expires_at: null, verification_refs: [] })],
  ["notification", parseNotificationIntentV1, envelope(`ntf:pos:v1:${uuid}`, { title: "Decision ready", summary: "One redacted decision needs review", alert_class: "authority_expiry", urgency: "high", quiet_hours_decision: "deliver", channel: "mac_native", deep_link: "jarvis://today/decision", dedup_key: "decision:1", state: "ready" })],
  ["memory candidate", parseMemoryCandidateV1, envelope(`memcand:pos:v1:${uuid}`, { kind: "verified_fact", content: "Task 9 passed independent verification", content_digest: digest("f"), target_digest: null, sensitivity: "personal", confidence: "verified", confirmation_state: "not_required", confirmation_refs: [], verification_refs: [`evi:pos:v1:${uuid}`], state: "approved" })],
  ["memory outbox", parseMemoryOutboxV1, envelope(`memout:pos:v1:${uuid}`, { candidate_id: `memcand:pos:v1:${uuid}`, candidate_digest: digest("1"), operation: "remember", provider_version: "second-brain-v1", attempt: 1, fence: 1, expected_artifact_selector: "sid:task-9", expected_artifact_digest: digest("2"), state: "queued" })],
  ["remote principal", parseRemotePrincipalV1, envelope(`rpr:pos:v1:${uuid}`, { subject: "principal:owner", client_kinds: ["mac", "phone"], credential_id: "cred:owner:1", public_key_digest: digest("3"), sign_count: 1, state: "active" }, { receipt_kind: "owner_enrollment", request_id: "request:enroll", receipt_id: "receipt:enroll", command_digest: digest("4"), principal_id: "principal:owner", expires_at: "2026-08-28T11:00:00.000Z" })],
  ["remote challenge", parseRemoteChallengeV1, { ...envelope(`rch:pos:v1:${uuid}`, { principal_id: `rpr:pos:v1:${uuid}`, session_id: "session:remote:1", command_digest: digest("5"), target_digest: digest("6"), args_digest: digest("7"), nonce: "nonce:remote:1", origin: "https://jarvis.tailnet", rp_id: "jarvis.tailnet", state: "issued" }), source: gatewaySource, evidence: [] }],
  ["remote approval", parseRemoteApprovalReceiptV1, { ...envelope(`rap:pos:v1:${uuid}`, { challenge_id: `rch:pos:v1:${uuid}`, principal_id: `rpr:pos:v1:${uuid}`, session_id: "session:remote:1", credential_id: "cred:owner:1", assertion_digest: digest("8"), command_digest: digest("5"), decision: "approve", single_use: true, state: "verified" }, { receipt_kind: "control_translation", request_id: "request:command", receipt_id: "receipt:command", command_digest: digest("5"), principal_id: "principal:owner", expires_at: "2026-08-28T11:00:00.000Z" }), source: gatewaySource, evidence: [] }],
] as const;

describe("personal contract round trips", () => {
  it.each(cases)("parses and canonically round-trips %s", (_name, parse, value) => {
    const parsed = parse(value);
    expect(JSON.parse(canonicalPersonalContractJson(parsed))).toEqual(parsed);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.payload)).toBe(true);
  });

  it("hashes reordered parsed envelopes identically", () => {
    const value = cases[0][2];
    const reordered = Object.fromEntries(Object.entries(value).reverse());
    const parsed = parseObservationEnvelopeV1(value);
    expect(canonicalPersonalContractJson(parsed)).toBe(canonicalize(parsed));
    expect(canonicalPersonalContractHash(parsed)).toBe(canonicalPersonalContractHash(parseObservationEnvelopeV1(reordered)));
  });

  it("recursively freezes parsed payloads", () => {
    const parsed = parseObservationEnvelopeV1(cases[0][2]);
    const nested = parsed.payload.value;
    expect(typeof nested).toBe("object");
    if (typeof nested !== "object" || nested === null) throw new TypeError("nested fixture must be an object");
    expect(Object.isFrozen(nested)).toBe(true);
    expect(Reflect.set(nested, "state", "completed")).toBe(false);
    expect(nested).toEqual({ state: "running", text: "payload is inert" });
  });
});
