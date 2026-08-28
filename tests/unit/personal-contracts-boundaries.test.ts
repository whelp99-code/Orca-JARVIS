import { describe, expect, it } from "vitest";
import { PersonalContractError, parseObservationEnvelopeV1, parseRemoteApprovalReceiptV1 } from "../../src/personal-validation.js";

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

  it("rejects extra remote approval fields", () => {
    const value = fixture(); value.id = `rap:pos:v1:${uuid}`;
    object(value).payload = { challenge_id: `rch:pos:v1:${uuid}`, principal_id: `rpr:pos:v1:${uuid}`, session_id: "session:1", credential_id: "cred:1", assertion_digest: digest("1"), command_digest: digest("2"), decision: "approve", single_use: true, state: "verified", approval: "self-minted" };
    value.source = { source_id: "src:pos:v1:gateway:primary", source_kind: "gateway", host_id: "host:pos:linux-control-plane", source_version: "gateway-v1", evidence_ref: "ref:gateway:1" };
    expect(() => parseRemoteApprovalReceiptV1(value)).toThrowError(PersonalContractError);
  });
});
