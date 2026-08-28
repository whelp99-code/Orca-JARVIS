import { describe, expect, it } from "vitest";
import * as contracts from "../../src/personal-contracts.js";
import {
  AUTHORITY_KINDS, CLIENT_KINDS, DAILY_LOOP_PHASES, DAILY_LOOP_STATES, FRESHNESS_STATES, MEMORY_CANDIDATE_KINDS,
  MEMORY_STATES, NOTIFICATION_STATES, OBSERVATION_STATES, POLICY_DECISIONS, RECOMMENDATION_STATES,
  REMOTE_APPROVAL_STATES, REMOTE_CHALLENGE_STATES, REMOTE_PRINCIPAL_STATES, SENSITIVITY_TIERS, SOURCE_KINDS, TRUST_LEVELS,
} from "../../src/personal-contracts.js";
import {
  parseContextSnapshotV1, parseDailyLoopRunV1, parseMemoryCandidateV1, parseMemoryOutboxV1, parseNotificationIntentV1, parseObservationEnvelopeV1,
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
  confirmationStates: ["not_required", "required", "confirmed", "rejected"],
  confidenceStates: ["verified", "confirmed", "inferred"],
  contextStates: ["sufficient", "insufficient"],
  hosts: ["host:pos:linux-control-plane", "host:pos:linux-second-brain", "host:pos:mac-client", "host:pos:phone-client"],
  memoryOperations: ["remember", "correct", "forget"],
  notificationChannels: ["in_app", "mac_native", "phone_web"],
  notificationUrgencies: ["low", "normal", "high", "critical"],
  policyReasons: ["POLICY_SATISFIED", "NO_DATA", "INPUT_STALE", "SOURCE_UNAVAILABLE", "SOURCE_OFFLINE", "EVIDENCE_INSUFFICIENT", "EVIDENCE_CONFLICT", "CONFIRMATION_REQUIRED", "AUTHORITY_REQUIRED", "QUIET_HOURS", "EXPIRED", "NOT_APPLICABLE"],
  quietDecisions: ["deliver", "defer", "suppress"],
  remoteDecisions: ["approve", "reject"],
  sourceProviders: ["jarvis", "orca", "task-timeline", "portfolio", "second-brain", "calendar", "mail", "messenger", "gateway", "mac-client", "phone-client"],
  challengeStates: ["issued", "consumed", "expired", "rejected"],
  principalStates: ["absent", "active", "revoked"],
  sensitivity: ["public", "personal", "sensitive", "restricted"],
  sources: ["authority", "live_adapter", "second_brain", "timeline", "gateway", "client"],
  trust: ["verified", "user_confirmed", "inferred", "untrusted"],
  limits: { PERSONAL_CONTRACT_VERSION: 1, PERSONAL_TEXT_BYTES_MAX: 4096, PERSONAL_LIST_ITEMS_MAX: 32, PERSONAL_VALUE_DEPTH_MAX: 6, PERSONAL_VALUE_KEYS_MAX: 64, PERSONAL_TOTAL_BYTES_MAX: 65536, PERSONAL_MAX_LIFETIME_MS: 2678400000 },
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
const approval = (commandDigest = digest, decision: "approve" | "reject" = "approve") => ({ schema_version: 1, receipt_id: "receipt:1", request_id: "request:1", decision, command_digest: commandDigest, signer_principal_id: "principal:owner", authenticated_session_id: "session:owner", key_id: "key:owner", algorithm: "Ed25519", issued_at: "2026-08-28T09:58:00.000Z", not_before: "2026-08-28T09:58:00.000Z", expires_at: "2026-08-28T10:10:00.000Z", nonce: "nonce:1", max_uses: 1, status: "issued", signature: "signed-receipt" });
function authorized(value: ReturnType<typeof base>, commandDigest = digest) { Object.assign(value, { authority: { authority_kind: "control_receipt", principal_id: "principal:owner", request_id: "request:1", receipt_id: "receipt:1" }, receipt: approval(commandDigest) }); return value; }
const fixtures = [
  [parseObservationEnvelopeV1, base(`obs:pos:v1:src:pos:v1:jarvis:primary:${uuid}`, { kind: "status", subject: "task", value: "value", trust: "verified", sensitivity: "personal", cursor: null, checkpoint: null, content_digest: digest, state: "fresh" }), "state", expected.observationStates],
  [parseContextSnapshotV1, base(`ctx:pos:v1:${uuid}`, { purpose: "daily", query: "query", included_observation_refs: [], included_memory_refs: [], excluded_refs: [], pending_authority_refs: [], conflicts: [], omissions: [], budgets: { max_items: 1, max_excerpt_bytes: 32, max_total_bytes: 512 }, state: "sufficient" }), "state", expected.contextStates],
  [parseRecommendationV1, base(`rec:pos:v1:${uuid}`, { context_id: `ctx:pos:v1:${uuid}`, context_digest: digest, actions: [], citations: [], conflicts: [], omissions: [], confidence_basis: "evidence", state: "eligible" }), "state", expected.recommendationStates],
  [parseNotificationIntentV1, base(`ntf:pos:v1:${uuid}`, { title: "Title", summary: "Summary", alert_class: "routine", urgency: "normal", quiet_hours_decision: "deliver", channel: "in_app", deep_link: "jarvis://today", dedup_key: "daily", state: "created" }), "state", expected.notificationStates],
  [parseRemoteChallengeV1, gateway(`rch:pos:v1:${uuid}`, { principal_id: `rpr:pos:v1:${uuid}`, session_id: "session:1", command_digest: digest, target_digest: digest, args_digest: digest, nonce: "nonce:1", origin: "https://jarvis.tailnet", rp_id: "jarvis.tailnet", state: "issued" }), "state", expected.challengeStates],
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
    const exported: Readonly<Record<string, unknown>> = contracts;
    expect(exported["SOURCE_PROVIDERS"]).toEqual(expected.sourceProviders); expect(exported["HOST_IDS"]).toEqual(expected.hosts); expect(exported["POLICY_REASON_CODES"]).toEqual(expected.policyReasons);
    expect(exported["MEMORY_OPERATIONS"]).toEqual(expected.memoryOperations); expect(exported["REMOTE_DECISIONS"]).toEqual(expected.remoteDecisions); expect(exported["CONTEXT_STATES"]).toEqual(expected.contextStates);
    expect(exported["NOTIFICATION_URGENCIES"]).toEqual(expected.notificationUrgencies); expect(exported["NOTIFICATION_CHANNELS"]).toEqual(expected.notificationChannels); expect(exported["QUIET_HOURS_DECISIONS"]).toEqual(expected.quietDecisions);
    expect(exported["MEMORY_CONFIRMATION_STATES"]).toEqual(expected.confirmationStates); expect(exported["MEMORY_CONFIDENCE_STATES"]).toEqual(expected.confidenceStates); expect(exported["MEMORY_OUTBOX_STATES"]).toEqual(expected.memoryStates);
    for (const [name, value] of Object.entries(expected.limits)) expect(exported[name]).toBe(value);
  });

  it.each(fixtures)("accepts every canonical state for %#", (parse, original, key, states) => {
    for (const state of states) { const value = structuredClone(original); value.payload[key] = state; expect(parse(value).payload[key]).toBe(state); }
  });

  it.each(fixtures)("rejects unknown neighboring state for %#", (parse, original, key) => {
    const value = structuredClone(original); value.payload[key] = "unknown_neighbor"; expect(() => parse(value)).toThrow();
  });

  it("parses every source provider with its independent host and kind", () => {
    const sourceMatrix = [
      ["jarvis", "authority", "host:pos:linux-control-plane"], ["orca", "live_adapter", "host:pos:linux-control-plane"], ["task-timeline", "timeline", "host:pos:linux-control-plane"], ["portfolio", "live_adapter", "host:pos:linux-control-plane"], ["second-brain", "second_brain", "host:pos:linux-second-brain"], ["calendar", "live_adapter", "host:pos:linux-control-plane"], ["mail", "live_adapter", "host:pos:linux-control-plane"], ["messenger", "live_adapter", "host:pos:linux-control-plane"], ["gateway", "gateway", "host:pos:linux-control-plane"], ["mac-client", "client", "host:pos:mac-client"], ["phone-client", "client", "host:pos:phone-client"],
    ] as const;
    for (const [provider, source_kind, host_id] of sourceMatrix) { const sourceId = `src:pos:v1:${provider}:primary`; const value = base(`obs:pos:v1:${sourceId}:${uuid}`, { kind: "status", subject: "task", value: "value", trust: "verified", sensitivity: "personal", cursor: null, checkpoint: null, content_digest: digest, state: "fresh" }); value.source = { source_id: sourceId, source_kind, host_id, source_version: "v1", evidence_ref: "ref:1" }; expect(parseObservationEnvelopeV1(value).source.source_id).toBe(sourceId); }
  });

  it("parses every notification and memory discriminant", () => {
    for (const urgency of expected.notificationUrgencies) { const value = structuredClone(fixtures[3][1]); value.payload.urgency = urgency; expect(parseNotificationIntentV1(value).payload.urgency).toBe(urgency); }
    for (const channel of expected.notificationChannels) { const value = structuredClone(fixtures[3][1]); value.payload.channel = channel; expect(parseNotificationIntentV1(value).payload.channel).toBe(channel); }
    for (const decision of expected.quietDecisions) { const value = structuredClone(fixtures[3][1]); value.payload.quiet_hours_decision = decision; expect(parseNotificationIntentV1(value).payload.quiet_hours_decision).toBe(decision); }
    for (const trust of expected.trust) { const value = structuredClone(fixtures[0][1]); value.payload.trust = trust; expect(parseObservationEnvelopeV1(value).payload.trust).toBe(trust); }
    for (const sensitivity of expected.sensitivity) { const value = structuredClone(fixtures[0][1]); value.payload.sensitivity = sensitivity; expect(parseObservationEnvelopeV1(value).payload.sensitivity).toBe(sensitivity); }
    const candidate = () => base(`memcand:pos:v1:${uuid}`, { kind: "verified_fact", content: "fact", content_digest: digest, target_digest: null, sensitivity: "personal", confidence: "verified", confirmation_state: "not_required", confirmation_refs: [], verification_refs: [], state: "proposed" });
    for (const confidence of expected.confidenceStates) { const value = candidate(); value.payload.confidence = confidence; expect(parseMemoryCandidateV1(value).payload.confidence).toBe(confidence); }
    for (const confirmationState of expected.confirmationStates) { const value = candidate(); value.payload.confirmation_state = confirmationState; value.payload.state = confirmationState === "required" ? "awaiting_confirmation" : confirmationState === "confirmed" ? "approved" : confirmationState === "rejected" ? "rejected" : "proposed"; if (confirmationState === "confirmed") { value.payload.confirmation_refs = ["receipt:1"]; value.receipt = { receipt_kind: "confirmation", candidate_digest: digest, approval: approval() }; } expect(parseMemoryCandidateV1(value).payload.confirmation_state).toBe(confirmationState); }
    for (const kind of expected.memoryKinds) { const value = candidate(); value.payload.kind = kind; if (kind === "forget") { value.payload.content = null; value.payload.content_digest = null; value.payload.target_digest = digest; } expect(parseMemoryCandidateV1(value).payload.kind).toBe(kind); }
  });

  it("parses every authority-aware workflow state", () => {
    for (const state of expected.dailyStates) {
      const verification_refs: string[] = []; const payload: Record<string, unknown> = { loop_date: "2026-08-28", phase: "morning", state, recommendation_id: null, context_id: null, request_id: null, command_digest: null, lease_owner: null, lease_fence: 0, lease_expires_at: null, verification_refs };
      let value = base(`wfr:pos:v1:${uuid}`, payload); const controlled = ["approved", "claimed", "running", "verifying", "completed", "uncertain", "cancelled"].includes(state);
      if (controlled) { payload.request_id = "request:1"; payload.command_digest = digest; value = authorized(value); }
      if (state === "waiting_approval") { payload.request_id = "request:1"; payload.command_digest = digest; }
      if (["claimed", "running", "verifying", "completed", "uncertain"].includes(state)) { payload.lease_owner = "worker:1"; payload.lease_fence = 1; payload.lease_expires_at = "2026-08-28T10:09:00.000Z"; }
      if (state === "completed") payload.verification_refs = ["evi:complete:1"];
      expect(parseDailyLoopRunV1(value).payload.state).toBe(state);
    }
  });

  it("parses every memory candidate state with coherent confirmation", () => {
    for (const state of expected.memoryStates) { const confirmationState = state === "awaiting_confirmation" ? "required" : state === "rejected" ? "rejected" : "not_required"; const payload = { kind: "verified_fact", content: "fact", content_digest: digest, target_digest: null, sensitivity: "personal", confidence: "verified", confirmation_state: confirmationState, confirmation_refs: [], verification_refs: [], state }; expect(parseMemoryCandidateV1(base(`memcand:pos:v1:${uuid}`, payload)).payload.state).toBe(state); }
  });

  it("parses every memory outbox state and operation with required bindings", () => {
    for (const state of expected.memoryStates) {
      const payload = { candidate_id: `memcand:pos:v1:${uuid}`, candidate_digest: digest, operation: "remember", provider_version: "v1", attempt: 1, fence: 1, expected_artifact_selector: "sid:1", expected_artifact_digest: digest, state };
      let receipt: Record<string, unknown> | null = null;
      if (["approved", "queued", "delivering"].includes(state)) receipt = { receipt_kind: "confirmation", candidate_digest: digest, approval: approval() };
      if (["accepted_unsettled", "settled", "uncertain"].includes(state)) receipt = { receipt_kind: "delivery", candidate_digest: digest, attempt: 1, fence: 1, invocation_digest: digest, artifact_digest: digest, accepted_at: "2026-08-28T10:00:00.000Z", reconciled_at: state === "settled" ? "2026-08-28T10:00:00.000Z" : null, approval: approval() };
      expect(parseMemoryOutboxV1(base(`memout:pos:v1:${uuid}`, payload, receipt)).payload.state).toBe(state);
    }
    for (const operation of expected.memoryOperations) { const payload = { candidate_id: `memcand:pos:v1:${uuid}`, candidate_digest: digest, operation, provider_version: "v1", attempt: 1, fence: 1, expected_artifact_selector: "sid:1", expected_artifact_digest: digest, state: "queued" }; expect(parseMemoryOutboxV1(base(`memout:pos:v1:${uuid}`, payload, { receipt_kind: "confirmation", candidate_digest: digest, approval: approval() })).payload.operation).toBe(operation); }
  });

  it("parses every principal and remote approval state with exact bindings", () => {
    for (const state of expected.principalStates) {
      let value = base(`rpr:pos:v1:${uuid}`, { subject: "principal:owner", client_kinds: ["mac"], credential_id: "cred:1", public_key_digest: digest, sign_count: 1, state });
      if (state !== "absent") { value = authorized(value); value.receipt = { receipt_kind: state === "active" ? "owner_enrollment" : "owner_revocation", credential_id: "cred:1", public_key_digest: digest, approval: approval() }; }
      expect(parseRemotePrincipalV1(value).payload.state).toBe(state);
    }
    for (const state of expected.approvalStates) {
      const decision = state === "rejected" ? "reject" : "approve"; const payload = { challenge_id: `rch:pos:v1:${uuid}`, principal_id: `rpr:pos:v1:${uuid}`, session_id: "session:owner", credential_id: "cred:1", assertion_digest: digest, command_digest: digest, target_digest: digest, args_digest: digest, decision, single_use: true, state };
      const verification = { receipt_kind: "remote_verification", challenge_id: payload.challenge_id, principal_id: payload.principal_id, session_id: payload.session_id, credential_id: payload.credential_id, assertion_digest: digest, command_digest: digest, target_digest: digest, args_digest: digest, decision, expires_at: "2026-08-28T12:00:00.000Z", result: state === "rejected" ? "rejected" : "verified" };
      const value = gateway(`rap:pos:v1:${uuid}`, payload); value.receipt = state === "translated" ? { receipt_kind: "control_translation", challenge_id: payload.challenge_id, principal_id: payload.principal_id, session_id: payload.session_id, credential_id: payload.credential_id, assertion_digest: digest, command_digest: digest, target_digest: digest, args_digest: digest, decision, expires_at: "2026-08-28T12:00:00.000Z", approval: { ...approval(digest, decision), signer_principal_id: payload.principal_id } } : verification; if (state === "translated") Object.assign(value, { authority: { authority_kind: "control_receipt", principal_id: payload.principal_id, request_id: "request:1", receipt_id: "receipt:1" } });
      expect(parseRemoteApprovalReceiptV1(value).payload.state).toBe(state);
    }
  });
});
