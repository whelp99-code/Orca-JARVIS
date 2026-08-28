import { describe, expect, it } from "vitest";
import {
  AUTHORITY_KINDS, CLIENT_KINDS, DAILY_LOOP_PHASES, DAILY_LOOP_STATES, FRESHNESS_STATES, MEMORY_CANDIDATE_KINDS,
  MEMORY_STATES, NOTIFICATION_STATES, OBSERVATION_STATES, POLICY_DECISIONS, RECOMMENDATION_STATES,
  REMOTE_APPROVAL_STATES, REMOTE_CHALLENGE_STATES, REMOTE_PRINCIPAL_STATES, SENSITIVITY_TIERS, SOURCE_KINDS, TRUST_LEVELS,
} from "../../src/personal-contracts.js";
import {
  parseDailyLoopRunV1, parseMemoryCandidateV1, parseNotificationIntentV1, parseObservationEnvelopeV1,
  parseRecommendationV1, parseRemoteApprovalReceiptV1, parseRemoteChallengeV1, parseRemotePrincipalV1,
} from "../../src/personal-validation.js";

const expected = {
  authority: ["none", "control_receipt"],
  clients: ["mac", "phone"],
  dailyPhases: ["morning", "in_day", "evening"],
  dailyStates: ["planned", "waiting_approval", "approved", "claimed", "running", "verifying", "completed", "failed", "blocked", "uncertain", "cancelled"],
  freshness: ["fresh", "stale", "no_data", "unavailable", "offline"],
  memoryKinds: ["verified_fact", "user_instruction", "inference", "correction", "forget"],
  memoryStates: ["proposed", "classified", "awaiting_confirmation", "approved", "queued", "delivering", "accepted_unsettled", "settled", "rejected", "uncertain", "expired"],
  notificationStates: ["created", "deferred", "ready", "delivering", "delivered", "suppressed", "failed", "expired"],
  observationStates: ["received", "validated", "fresh", "stale", "no_data", "unavailable", "offline", "expired", "rejected"],
  policy: ["allow", "deny", "abstain", "not_applicable"],
  recommendationStates: ["drafted", "parsed", "eligible", "abstained", "presented", "selected", "rejected", "expired"],
  approvalStates: ["verified", "translated", "rejected"],
  challengeStates: ["issued", "consumed", "expired", "rejected"],
  principalStates: ["absent", "active", "revoked"],
  sensitivity: ["public", "personal", "sensitive", "restricted"],
  sources: ["authority", "live_adapter", "second_brain", "timeline", "gateway", "client"],
  trust: ["verified", "user_confirmed", "inferred", "untrusted"],
} as const;

const uuid = "018f0d4e-7b2a-7cc1-8a2b-3c4d5e6f7081";
const digest = `sha256:${"a".repeat(64)}`;
function base(id: string, payload: Record<string, unknown>, receipt: Record<string, unknown> | null = null) {
  return { schema_version: 1, id, created_at: "2026-08-28T10:00:00.000Z", observed_at: "2026-08-28T09:59:00.000Z", valid_at: "2026-08-28T09:59:00.000Z",
    source: { source_id: "src:pos:v1:jarvis:primary", source_kind: "authority", host_id: "host:pos:linux-control-plane", source_version: "v1", evidence_ref: "ref:1" },
    authority: { authority_kind: "none", principal_id: null, request_id: null, receipt_id: null }, freshness: { state: "fresh", checked_at: "2026-08-28T10:00:00.000Z", fresh_until: "2026-08-28T11:00:00.000Z" },
    expires_at: "2026-08-28T12:00:00.000Z", idempotency_key: `idem:pos:v1:states:${"b".repeat(64)}`, correlation_id: `corr:pos:v1:${uuid}`, causation_id: null,
    payload, policy_decision: { decision: "allow", policy_version: "v1", reason_codes: ["POLICY_SATISFIED"] }, evidence: [], receipt };
}
function gateway(id: string, payload: Record<string, unknown>) { const value = base(id, payload); value.source = { source_id: "src:pos:v1:gateway:primary", source_kind: "gateway", host_id: "host:pos:linux-control-plane", source_version: "v1", evidence_ref: "ref:1" }; return value; }
function receipted(value: ReturnType<typeof base>, kind: "owner_enrollment" | "control_translation") { value.receipt = { receipt_kind: kind, request_id: "request:1", receipt_id: "receipt:1", command_digest: digest, principal_id: "principal:owner", expires_at: "2026-08-28T11:00:00.000Z" }; return value; }
const fixtures = [
  [parseObservationEnvelopeV1, base(`obs:pos:v1:src:pos:v1:jarvis:primary:${uuid}`, { kind: "status", subject: "task", value: "value", trust: "verified", sensitivity: "personal", cursor: null, checkpoint: null, content_digest: digest, state: "fresh" }), "state", expected.observationStates],
  [parseRecommendationV1, base(`rec:pos:v1:${uuid}`, { context_id: `ctx:pos:v1:${uuid}`, context_digest: digest, actions: [], citations: [], conflicts: [], omissions: [], confidence_basis: "evidence", state: "eligible" }), "state", expected.recommendationStates],
  [parseDailyLoopRunV1, base(`wfr:pos:v1:${uuid}`, { loop_date: "2026-08-28", phase: "morning", state: "planned", recommendation_id: null, context_id: null, request_id: null, lease_owner: null, lease_fence: 0, lease_expires_at: null, verification_refs: [] }), "state", expected.dailyStates],
  [parseNotificationIntentV1, base(`ntf:pos:v1:${uuid}`, { title: "Title", summary: "Summary", alert_class: "routine", urgency: "normal", quiet_hours_decision: "deliver", channel: "in_app", deep_link: "jarvis://today", dedup_key: "daily", state: "created" }), "state", expected.notificationStates],
  [parseMemoryCandidateV1, base(`memcand:pos:v1:${uuid}`, { kind: "verified_fact", content: "fact", content_digest: digest, target_digest: null, sensitivity: "personal", confidence: "verified", confirmation_state: "not_required", confirmation_refs: [], verification_refs: [], state: "proposed" }), "state", expected.memoryStates],
  [parseRemotePrincipalV1, receipted(base(`rpr:pos:v1:${uuid}`, { subject: "principal:owner", client_kinds: ["mac"], credential_id: "cred:1", public_key_digest: digest, sign_count: 0, state: "absent" }), "owner_enrollment"), "state", expected.principalStates],
  [parseRemoteChallengeV1, gateway(`rch:pos:v1:${uuid}`, { principal_id: `rpr:pos:v1:${uuid}`, session_id: "session:1", command_digest: digest, target_digest: digest, args_digest: digest, nonce: "nonce:1", origin: "https://jarvis.tailnet", rp_id: "jarvis.tailnet", state: "issued" }), "state", expected.challengeStates],
  [parseRemoteApprovalReceiptV1, receipted(gateway(`rap:pos:v1:${uuid}`, { challenge_id: `rch:pos:v1:${uuid}`, principal_id: `rpr:pos:v1:${uuid}`, session_id: "session:1", credential_id: "cred:1", assertion_digest: digest, command_digest: digest, decision: "approve", single_use: true, state: "verified" }), "control_translation"), "state", expected.approvalStates],
] as const;

describe("canonical todo-2 discriminant tables", () => {
  it("exports exact independent literal inventories", () => {
    expect(AUTHORITY_KINDS).toEqual(expected.authority); expect(CLIENT_KINDS).toEqual(expected.clients);
    expect(DAILY_LOOP_PHASES).toEqual(expected.dailyPhases); expect(DAILY_LOOP_STATES).toEqual(expected.dailyStates);
    expect(FRESHNESS_STATES).toEqual(expected.freshness); expect(MEMORY_CANDIDATE_KINDS).toEqual(expected.memoryKinds);
    expect(MEMORY_STATES).toEqual(expected.memoryStates); expect(NOTIFICATION_STATES).toEqual(expected.notificationStates);
    expect(OBSERVATION_STATES).toEqual(expected.observationStates); expect(POLICY_DECISIONS).toEqual(expected.policy);
    expect(RECOMMENDATION_STATES).toEqual(expected.recommendationStates); expect(REMOTE_APPROVAL_STATES).toEqual(expected.approvalStates);
    expect(REMOTE_CHALLENGE_STATES).toEqual(expected.challengeStates); expect(REMOTE_PRINCIPAL_STATES).toEqual(expected.principalStates);
    expect(SENSITIVITY_TIERS).toEqual(expected.sensitivity); expect(SOURCE_KINDS).toEqual(expected.sources); expect(TRUST_LEVELS).toEqual(expected.trust);
  });

  it.each(fixtures)("accepts every canonical state for %#", (parse, original, key, states) => {
    for (const state of states) { const value = structuredClone(original); value.payload[key] = state; expect(parse(value).payload[key]).toBe(state); }
  });

  it.each(fixtures)("rejects unknown neighboring state for %#", (parse, original, key) => {
    const value = structuredClone(original); value.payload[key] = "unknown_neighbor"; expect(() => parse(value)).toThrow();
  });
});
