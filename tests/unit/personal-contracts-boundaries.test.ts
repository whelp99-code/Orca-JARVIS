import { describe, expect, it } from "vitest";
import { canonicalize } from "../../src/canonical.js";
import { PersonalContractError, parseContextSnapshotV1, parseDailyLoopRunV1, parseMemoryCandidateV1, parseMemoryOutboxV1, parseObservationEnvelopeV1, parseRemoteApprovalReceiptV1, parseRemotePrincipalV1 } from "../../src/personal-validation.js";

const uuid = "018f0d4e-7b2a-7cc1-8a2b-3c4d5e6f7081";
const digest = (character: string) => `sha256:${character.repeat(64)}`;
function fixture() {
  const sourceId = "src:pos:v1:orca:primary";
  return {
    schema_version: 1, id: `obs:pos:v1:${sourceId}:${uuid}`,
    created_at: "2026-08-28T10:00:00.000Z", observed_at: "2026-08-28T09:59:00.000Z", valid_at: "2026-08-28T09:59:00.000Z",
    source: { source_id: sourceId, source_kind: "live_adapter", host_id: "host:pos:linux-control-plane", source_version: "orca-v1", evidence_ref: "ref:orca:1" },
    authority: { authority_kind: "none", principal_id: null, request_id: null, receipt_id: null },
    freshness: { state: "fresh", checked_at: "2026-08-28T10:00:00.000Z", fresh_until: "2026-08-28T11:00:00.000Z" },
    expires_at: "2026-08-28T12:00:00.000Z", idempotency_key: `idem:pos:v1:observation:${"b".repeat(64)}`,
    correlation_id: `corr:pos:v1:${uuid}`, causation_id: null,
    payload: { kind: "work_status", subject: "task:9", value: { excerpt: "bounded" }, trust: "verified", sensitivity: "personal", cursor: "cursor:1", checkpoint: "checkpoint:1", content_digest: digest("c"), state: "fresh" },
    policy_decision: { decision: "allow", policy_version: "personal-os-policy-v1", reason_codes: ["POLICY_SATISFIED"] },
    evidence: [{ evidence_id: `evi:pos:v1:${uuid}`, digest: digest("a"), kind: "live_observation", source_id: sourceId, observed_at: "2026-08-28T09:59:00.000Z" }], receipt: null,
  };
}
function isObject(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function object(value: unknown): Record<string, unknown> {
  if (!isObject(value)) throw new TypeError("fixture object required");
  return value;
}
function failure(mutate: (value: Record<string, unknown>) => void): string | undefined {
  const value = object(structuredClone(fixture())); mutate(value);
  try { parseObservationEnvelopeV1(value); } catch (error) { if (error instanceof PersonalContractError) return error.code; throw error; }
  return undefined;
}
function family(id: string, payload: Record<string, unknown>, receipt: Record<string, unknown> | null = null): Record<string, unknown> {
  const value = object(structuredClone(fixture())); value.id = id; value.payload = payload; value.receipt = receipt; value.source = { source_id: "src:pos:v1:jarvis:primary", source_kind: "authority", host_id: "host:pos:linux-control-plane", source_version: "v1", evidence_ref: "ref:1" }; value.evidence = []; return value;
}
const approval = (commandDigest: string, principal = "principal:owner") => ({ schema_version: 1, receipt_id: "receipt:1", request_id: "request:1", decision: "approve", command_digest: commandDigest, signer_principal_id: principal, authenticated_session_id: "session:owner", key_id: "key:owner", algorithm: "Ed25519", issued_at: "2026-08-28T09:58:00.000Z", not_before: "2026-08-28T09:58:00.000Z", expires_at: "2026-08-28T10:10:00.000Z", nonce: "nonce:1", max_uses: 1, status: "issued", signature: "signed-receipt" });

describe("personal contract deterministic boundary matrix", () => {
  it.each([
    ["unknown version", (value: Record<string, unknown>) => { value.schema_version = 2; }, "PERSONAL_CONTRACT_VERSION_UNSUPPORTED"],
    ["missing version", (value: Record<string, unknown>) => { delete value.schema_version; }, "PERSONAL_CONTRACT_VERSION_UNSUPPORTED"],
    ["unknown source", (value: Record<string, unknown>) => { object(value.source).source_id = "src:pos:v1:unknown:primary"; }, "PERSONAL_CONTRACT_INVALID"],
    ["unknown trust", (value: Record<string, unknown>) => { object(value.payload).trust = "trusted_by_model"; }, "PERSONAL_CONTRACT_INVALID"],
    ["unknown sensitivity", (value: Record<string, unknown>) => { object(value.payload).sensitivity = "secret"; }, "PERSONAL_CONTRACT_INVALID"],
    ["unknown state", (value: Record<string, unknown>) => { object(value.payload).state = "done"; }, "PERSONAL_CONTRACT_INVALID"],
    ["unknown authority", (value: Record<string, unknown>) => { object(value.authority).authority_kind = "model"; }, "PERSONAL_CONTRACT_INVALID"],
    ["unknown policy reason", (value: Record<string, unknown>) => { object(value.policy_decision).reason_codes = ["MODEL_SAYS_OK"]; }, "PERSONAL_CONTRACT_INVALID"],
    ["impossible timestamp", (value: Record<string, unknown>) => { value.observed_at = "2026-02-30T00:00:00.000Z"; }, "PERSONAL_CONTRACT_INVALID"],
    ["non-millisecond timestamp", (value: Record<string, unknown>) => { value.observed_at = "2026-08-28T09:59:00Z"; }, "PERSONAL_CONTRACT_INVALID"],
    ["reversed chronology", (value: Record<string, unknown>) => { value.created_at = "2026-08-28T09:00:00.000Z"; }, "PERSONAL_CONTRACT_INVALID"],
    ["freshness after expiry", (value: Record<string, unknown>) => { object(value.freshness).fresh_until = "2026-08-28T13:00:00.000Z"; }, "PERSONAL_CONTRACT_INVALID"],
    ["oversized multibyte excerpt", (value: Record<string, unknown>) => { object(object(value.payload).value).excerpt = "😀".repeat(1025); }, "PERSONAL_CONTRACT_INVALID"],
    ["list overflow", (value: Record<string, unknown>) => { const first = Array.isArray(value.evidence) ? value.evidence[0] : null; value.evidence = Array.from({ length: 33 }, () => first); }, "PERSONAL_CONTRACT_INVALID"],
    ["duplicate semantic list", (value: Record<string, unknown>) => { const first = Array.isArray(value.evidence) ? value.evidence[0] : null; value.evidence = [first, first]; }, "PERSONAL_CONTRACT_INVALID"],
    ["invalid UUIDv7", (value: Record<string, unknown>) => { value.correlation_id = "corr:pos:v1:018f0d4e-7b2a-4cc1-8a2b-3c4d5e6f7081"; }, "PERSONAL_CONTRACT_INVALID"],
    ["invalid family prefix", (value: Record<string, unknown>) => { value.id = `ctx:pos:v1:${uuid}`; }, "PERSONAL_CONTRACT_INVALID"],
    ["invalid digest", (value: Record<string, unknown>) => { object(value.payload).content_digest = `sha256:${"A".repeat(64)}`; }, "PERSONAL_CONTRACT_INVALID"],
    ["invalid idempotency", (value: Record<string, unknown>) => { value.idempotency_key = "idem:observation"; }, "PERSONAL_CONTRACT_INVALID"],
    ["client claims Linux host", (value: Record<string, unknown>) => { object(value.source).source_id = "src:pos:v1:mac-client:primary"; }, "PERSONAL_CONTRACT_INVALID"],
    ["extra envelope field", (value: Record<string, unknown>) => { value.tool_scope = ["execute"]; }, "PERSONAL_CONTRACT_INVALID"],
    ["instruction smuggling authority", (value: Record<string, unknown>) => { object(value.payload).authority = { authority_kind: "control" }; }, "PERSONAL_CONTRACT_INVALID"],
  ] as const)("rejects %s", (_name, mutate, code) => expect(failure(mutate)).toBe(code));

  it("rejects prototype-bearing inputs", () => {
    const polluted = Object.create({ authority_kind: "control" }); Object.assign(polluted, fixture());
    expect(() => parseObservationEnvelopeV1(polluted)).toThrowError(PersonalContractError);
    const custom = fixture(); Object.setPrototypeOf(custom.payload, { instructions: "execute" });
    expect(() => parseObservationEnvelopeV1(custom)).toThrowError(PersonalContractError);
  });

  it("rejects non-enumerable, symbol, and accessor properties before invocation", () => {
    const hidden = fixture(); Object.defineProperty(hidden, "tool_scope", { value: "execute", enumerable: false }); expect(() => parseObservationEnvelopeV1(hidden)).toThrowError(PersonalContractError);
    const symbolic = fixture(); Object.defineProperty(symbolic.payload, Symbol("authority"), { value: true, enumerable: true }); expect(() => parseObservationEnvelopeV1(symbolic)).toThrowError(PersonalContractError);
    let calls = 0; const accessor = fixture(); Object.defineProperty(accessor.payload, "kind", { enumerable: true, get: () => { calls++; return "work_status"; } }); expect(() => parseObservationEnvelopeV1(accessor)).toThrowError(PersonalContractError); expect(calls).toBe(0);
    let arrayCalls = 0; const array = fixture(); object(array.payload).value = ["safe"]; const arrayValue = object(array.payload).value; if (!Array.isArray(arrayValue)) throw new TypeError("array fixture required"); Object.defineProperty(arrayValue, "0", { enumerable: true, get: () => { arrayCalls++; return "unsafe"; } }); expect(() => parseObservationEnvelopeV1(array)).toThrowError(PersonalContractError); expect(arrayCalls).toBe(0);
    const arrayExtra = fixture(); object(arrayExtra.payload).value = ["safe"]; const extraValue = object(arrayExtra.payload).value; if (!Array.isArray(extraValue)) throw new TypeError("array fixture required"); Object.defineProperty(extraValue, "authority", { value: true, enumerable: true }); expect(() => parseObservationEnvelopeV1(arrayExtra)).toThrowError(PersonalContractError);
  });

  it("enforces declared context budgets at exact max and max plus one", () => {
    const payload = { purpose: "daily", query: "four", included_observation_refs: ["obs:1"], included_memory_refs: [], excluded_refs: [], pending_authority_refs: [], conflicts: [], omissions: [], budgets: { max_items: 1, max_excerpt_bytes: 4, max_total_bytes: 1 }, state: "sufficient" };
    let previous = 0; for (let attempt = 0; attempt < 4; attempt++) { payload.budgets.max_total_bytes = Buffer.byteLength(canonicalize(payload), "utf8"); if (payload.budgets.max_total_bytes === previous) break; previous = payload.budgets.max_total_bytes; }
    expect(parseContextSnapshotV1(family(`ctx:pos:v1:${uuid}`, payload)).payload.query).toBe("four");
    expect(() => parseContextSnapshotV1(family(`ctx:pos:v1:${uuid}`, { ...payload, query: "fives" }))).toThrowError(PersonalContractError);
    expect(() => parseContextSnapshotV1(family(`ctx:pos:v1:${uuid}`, { ...payload, included_memory_refs: ["sid:2"] }))).toThrowError(PersonalContractError);
    expect(() => parseContextSnapshotV1(family(`ctx:pos:v1:${uuid}`, { ...payload, budgets: { ...payload.budgets, max_total_bytes: payload.budgets.max_total_bytes - 1 } }))).toThrowError(PersonalContractError);
  });

  it("enforces every exported global limit at max and max plus one", () => {
    const textMax = fixture(); object(textMax.payload).value = "a".repeat(4096); expect(parseObservationEnvelopeV1(textMax).payload.value).toHaveLength(4096); object(textMax.payload).value = "a".repeat(4097); expect(() => parseObservationEnvelopeV1(textMax)).toThrowError(PersonalContractError);
    const listMax = fixture(); listMax.evidence = Array.from({ length: 32 }, (_, index) => ({ evidence_id: `evi:pos:v1:018f0d4e-7b2a-7cc1-8a2b-3c4d5e6f70${index.toString(16).padStart(2, "0")}`, digest: digest((index % 16).toString(16)), kind: "live", source_id: "src:pos:v1:orca:primary", observed_at: "2026-08-28T09:59:00.000Z" })); expect(parseObservationEnvelopeV1(listMax).evidence).toHaveLength(32); listMax.evidence.push({ evidence_id: "evi:pos:v1:018f0d4e-7b2a-7cc1-8a2b-3c4d5e6f7020", digest: digest("f"), kind: "live", source_id: "src:pos:v1:orca:primary", observed_at: "2026-08-28T09:59:00.000Z" }); expect(() => parseObservationEnvelopeV1(listMax)).toThrowError(PersonalContractError);
    let nested: unknown = "leaf"; for (let depth = 0; depth < 6; depth++) nested = { next: nested }; const depthMax = fixture(); object(depthMax.payload).value = nested; expect(parseObservationEnvelopeV1(depthMax).payload.value).toBeDefined(); object(depthMax.payload).value = { next: nested }; expect(() => parseObservationEnvelopeV1(depthMax)).toThrowError(PersonalContractError);
    const keysMax = fixture(); object(keysMax.payload).value = Object.fromEntries(Array.from({ length: 64 }, (_, index) => [`k${index}`, index])); expect(parseObservationEnvelopeV1(keysMax).payload.value).toBeDefined(); object(object(keysMax.payload).value)["overflow"] = 65; expect(() => parseObservationEnvelopeV1(keysMax)).toThrowError(PersonalContractError);
    const lifetime = fixture(); lifetime.expires_at = "2026-09-28T10:00:00.000Z"; expect(parseObservationEnvelopeV1(lifetime).expires_at).toBe(lifetime.expires_at); lifetime.expires_at = "2026-09-28T10:00:00.001Z"; expect(() => parseObservationEnvelopeV1(lifetime)).toThrowError(PersonalContractError);
    const total = fixture(); const chunks = Array.from({ length: 15 }, () => "a".repeat(4096)); object(total.payload).value = [...chunks, "a"]; const current = Buffer.byteLength(canonicalize(total), "utf8"); const padding = 65536 - current; if (padding < 0 || padding > 4095) throw new RangeError("total fixture padding invalid"); object(total.payload).value = [...chunks, "a".repeat(padding + 1)]; expect(Buffer.byteLength(canonicalize(total), "utf8")).toBe(65536); expect(parseObservationEnvelopeV1(total).payload.value).toBeDefined(); object(total.payload).value = [...chunks, "a".repeat(padding + 2)]; expect(() => parseObservationEnvelopeV1(total)).toThrowError(PersonalContractError);
  });

  it.each(["approved", "claimed", "running", "verifying", "completed", "uncertain", "cancelled"])("rejects workflow state %s without exact control authority", state => {
    const payload = { loop_date: "2026-08-28", phase: "morning", state, recommendation_id: null, context_id: null, request_id: state === "approved" ? "request:1" : null, command_digest: state === "approved" ? digest("9") : null, lease_owner: null, lease_fence: 0, lease_expires_at: null, verification_refs: [] };
    expect(() => parseDailyLoopRunV1(family(`wfr:pos:v1:${uuid}`, payload))).toThrowError(PersonalContractError);
  });

  it("rejects every mismatched workflow control and lease binding", () => {
    const payload = { loop_date: "2026-08-28", phase: "morning", state: "running", recommendation_id: null, context_id: null, request_id: "request:1", command_digest: digest("9"), lease_owner: "worker:1", lease_fence: 1, lease_expires_at: "2026-08-28T10:09:00.000Z", verification_refs: [] }; const valid = family(`wfr:pos:v1:${uuid}`, payload, approval(digest("9"))); valid.authority = { authority_kind: "control_receipt", principal_id: "principal:owner", request_id: "request:1", receipt_id: "receipt:1" }; expect(parseDailyLoopRunV1(valid).payload.state).toBe("running");
    const mutations = [(value: Record<string, unknown>) => { object(value.authority).principal_id = "principal:wrong"; }, (value: Record<string, unknown>) => { object(value.receipt).command_digest = digest("8"); }, (value: Record<string, unknown>) => { object(value.payload).request_id = "request:wrong"; }, (value: Record<string, unknown>) => { object(value.payload).lease_fence = 0; }, (value: Record<string, unknown>) => { object(value.payload).lease_expires_at = "2026-08-28T10:11:00.000Z"; }];
    for (const mutate of mutations) { const changed = object(structuredClone(valid)); mutate(changed); expect(() => parseDailyLoopRunV1(changed)).toThrowError(PersonalContractError); }
  });

  it("rejects sensitive candidate approval and every outbox effect state without bindings", () => {
    const candidate = { kind: "verified_fact", content: "sensitive fact", content_digest: digest("1"), target_digest: null, sensitivity: "sensitive", confidence: "verified", confirmation_state: "required", confirmation_refs: [], verification_refs: ["evi:1"], state: "approved" };
    expect(() => parseMemoryCandidateV1(family(`memcand:pos:v1:${uuid}`, candidate))).toThrowError(PersonalContractError);
    for (const state of ["queued", "delivering", "accepted_unsettled", "settled"] as const) {
      const outbox = { candidate_id: `memcand:pos:v1:${uuid}`, candidate_digest: digest("2"), operation: "remember", provider_version: "v1", attempt: 1, fence: 1, expected_artifact_selector: "sid:1", expected_artifact_digest: digest("3"), state };
      expect(() => parseMemoryOutboxV1(family(`memout:pos:v1:${uuid}`, outbox))).toThrowError(PersonalContractError);
    }
  });

  it("binds memory confirmation, delivery, and reconciliation exactly", () => {
    const candidateDigest = digest("2"); const candidatePayload = { kind: "verified_fact", content: "sensitive fact", content_digest: candidateDigest, target_digest: null, sensitivity: "sensitive", confidence: "verified", confirmation_state: "confirmed", confirmation_refs: ["receipt:1"], verification_refs: ["evi:1"], state: "approved" }; const candidate = family(`memcand:pos:v1:${uuid}`, candidatePayload, { receipt_kind: "confirmation", candidate_digest: candidateDigest, approval: approval(candidateDigest) }); expect(parseMemoryCandidateV1(candidate).payload.state).toBe("approved"); const wrongCandidate = object(structuredClone(candidate)); object(wrongCandidate.receipt).candidate_digest = digest("3"); expect(() => parseMemoryCandidateV1(wrongCandidate)).toThrowError(PersonalContractError);
    const outboxPayload = { candidate_id: `memcand:pos:v1:${uuid}`, candidate_digest: candidateDigest, operation: "remember", provider_version: "v1", attempt: 2, fence: 3, expected_artifact_selector: "sid:1", expected_artifact_digest: digest("4"), state: "settled" }; const delivery = { receipt_kind: "delivery", candidate_digest: candidateDigest, attempt: 2, fence: 3, invocation_digest: digest("5"), artifact_digest: digest("4"), accepted_at: "2026-08-28T10:00:00.000Z", reconciled_at: "2026-08-28T10:00:00.000Z", approval: approval(candidateDigest) }; const outbox = family(`memout:pos:v1:${uuid}`, outboxPayload, delivery); expect(parseMemoryOutboxV1(outbox).payload.state).toBe("settled");
    for (const field of ["candidate_digest", "artifact_digest", "attempt", "fence", "reconciled_at"] as const) { const changed = object(structuredClone(outbox)); object(changed.receipt)[field] = field === "attempt" || field === "fence" ? 99 : field === "reconciled_at" ? null : digest("6"); expect(() => parseMemoryOutboxV1(changed)).toThrowError(PersonalContractError); }
  });

  it("rejects wrong remote enrollment and translated approval bindings", () => {
    const principal = family(`rpr:pos:v1:${uuid}`, { subject: "principal:owner", client_kinds: ["mac"], credential_id: "cred:1", public_key_digest: digest("4"), sign_count: 1, state: "active" }, { receipt_kind: "delivery", request_id: "request:1", receipt_id: "receipt:1", command_digest: digest("4"), principal_id: "principal:owner", expires_at: "2026-08-28T11:00:00.000Z" });
    expect(() => parseRemotePrincipalV1(principal)).toThrowError(PersonalContractError);
    const remote = family(`rap:pos:v1:${uuid}`, { challenge_id: `rch:pos:v1:${uuid}`, principal_id: `rpr:pos:v1:${uuid}`, session_id: "session:owner", credential_id: "cred:1", assertion_digest: digest("5"), command_digest: digest("6"), target_digest: digest("7"), args_digest: digest("8"), decision: "approve", single_use: true, state: "translated" }, { receipt_kind: "control_translation", challenge_id: `rch:pos:v1:${uuid}`, principal_id: `rpr:pos:v1:${uuid}`, session_id: "session:owner", credential_id: "cred:1", assertion_digest: digest("5"), target_digest: digest("7"), args_digest: digest("8"), decision: "approve", approval: approval(digest("6"), "principal:wrong") });
    remote.source = { source_id: "src:pos:v1:gateway:primary", source_kind: "gateway", host_id: "host:pos:linux-control-plane", source_version: "v1", evidence_ref: "ref:1" }; object(remote).authority = { authority_kind: "control_receipt", principal_id: `rpr:pos:v1:${uuid}`, request_id: "request:1", receipt_id: "receipt:1" };
    expect(() => parseRemoteApprovalReceiptV1(remote)).toThrowError(PersonalContractError);
  });

  it("rejects every mismatched remote translation binding", () => {
    const principalId = `rpr:pos:v1:${uuid}`; const challengeId = `rch:pos:v1:${uuid}`; const commandDigest = digest("6"); const payload = { challenge_id: challengeId, principal_id: principalId, session_id: "session:owner", credential_id: "cred:1", assertion_digest: digest("5"), command_digest: commandDigest, target_digest: digest("7"), args_digest: digest("8"), decision: "approve", single_use: true, state: "translated" }; const receipt = { receipt_kind: "control_translation", challenge_id: challengeId, principal_id: principalId, session_id: "session:owner", credential_id: "cred:1", assertion_digest: digest("5"), command_digest: commandDigest, target_digest: digest("7"), args_digest: digest("8"), decision: "approve", expires_at: "2026-08-28T12:00:00.000Z", approval: approval(commandDigest, principalId) }; const valid = family(`rap:pos:v1:${uuid}`, payload, receipt); valid.source = { source_id: "src:pos:v1:gateway:primary", source_kind: "gateway", host_id: "host:pos:linux-control-plane", source_version: "v1", evidence_ref: "ref:1" }; valid.authority = { authority_kind: "control_receipt", principal_id: principalId, request_id: "request:1", receipt_id: "receipt:1" }; expect(parseRemoteApprovalReceiptV1(valid).payload.state).toBe("translated");
    const mutations = [(value: Record<string, unknown>) => { object(value.authority).request_id = "request:wrong"; }, (value: Record<string, unknown>) => { object(value.receipt).challenge_id = `rch:pos:v1:018f0d4e-7b2a-7cc1-8a2b-3c4d5e6f7082`; }, (value: Record<string, unknown>) => { object(value.receipt).principal_id = `rpr:pos:v1:018f0d4e-7b2a-7cc1-8a2b-3c4d5e6f7082`; }, (value: Record<string, unknown>) => { object(value.receipt).session_id = "session:wrong"; }, (value: Record<string, unknown>) => { object(value.receipt).credential_id = "cred:wrong"; }, (value: Record<string, unknown>) => { object(value.receipt).assertion_digest = digest("a"); }, (value: Record<string, unknown>) => { object(value.receipt).command_digest = digest("a"); }, (value: Record<string, unknown>) => { object(value.receipt).target_digest = digest("a"); }, (value: Record<string, unknown>) => { object(value.receipt).args_digest = digest("a"); }, (value: Record<string, unknown>) => { object(object(value.receipt).approval).command_digest = digest("a"); }, (value: Record<string, unknown>) => { object(value.receipt).decision = "reject"; }, (value: Record<string, unknown>) => { object(value.receipt).expires_at = "2026-08-28T11:59:59.999Z"; }, (value: Record<string, unknown>) => { object(object(value.receipt).approval).expires_at = "2026-08-28T09:59:59.999Z"; }];
    for (const mutate of mutations) { const changed = object(structuredClone(valid)); mutate(changed); expect(() => parseRemoteApprovalReceiptV1(changed)).toThrowError(PersonalContractError); }
  });

  it("rejects extra remote approval fields", () => {
    const value = fixture(); value.id = `rap:pos:v1:${uuid}`;
    object(value).payload = { challenge_id: `rch:pos:v1:${uuid}`, principal_id: `rpr:pos:v1:${uuid}`, session_id: "session:1", credential_id: "cred:1", assertion_digest: digest("1"), command_digest: digest("2"), decision: "approve", single_use: true, state: "verified", approval: "self-minted" };
    value.source = { source_id: "src:pos:v1:gateway:primary", source_kind: "gateway", host_id: "host:pos:linux-control-plane", source_version: "gateway-v1", evidence_ref: "ref:gateway:1" };
    expect(() => parseRemoteApprovalReceiptV1(value)).toThrowError(PersonalContractError);
  });
});
