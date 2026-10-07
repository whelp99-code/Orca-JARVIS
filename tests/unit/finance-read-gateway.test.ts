import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { JarvisError } from "../../src/jarvis-error.js";
import {
  CORE5_INTEGRATION_AUDIENCE, CORE5_INTEGRATION_CAPABILITIES,
  CORE5_INTEGRATION_V2_CAPABILITIES, Core5CapabilityRegistry, Core5FinanceReadGateway,
  StaticVerifiedIssuer, parseCommandEnvelope, parseFinanceReadEnvelope,
  type RegisteredFinanceReadTarget,
} from "../../src/integration/index.js";

const NOW = new Date("2026-10-06T00:00:00.000Z");
const TARGET: RegisteredFinanceReadTarget = {
  target_id: "price:local-test", provider: "price", supported_versions: [2],
  capabilities: ["finance.read"], principal: "agent:jarvis",
  workspace: "company:local-test", company_ids: ["company:local-test"],
};
function request() {
  return {
    schema_version: 2, capability: "finance.read",
    operation_id: "op:read", attempt_id: "attempt:read", lease_fence: "fence:read",
    target_id: TARGET.target_id,
    payload: { company_id: "company:local-test", case_id: "case:local-test",
      source_revision: "revision:local-test", view: "reconciliation" },
    caller: { principal: "agent:jarvis", workspace: "company:local-test",
      purpose: "finance.read", expiry: "2026-10-06T01:00:00.000Z",
      audience: CORE5_INTEGRATION_AUDIENCE },
  };
}
function gateway(target = TARGET, enabled = true) {
  return new Core5FinanceReadGateway([target], new StaticVerifiedIssuer({
    principal: TARGET.principal, workspace: TARGET.workspace, audience: CORE5_INTEGRATION_AUDIENCE,
  }), { CORE5_INTEGRATION_ENABLED: enabled ? "1" : "0" });
}
function expectCode(run: () => unknown, code: string) {
  expect(run).toThrowError(expect.objectContaining({ code }));
}

describe("FP5 J1 finance read preparation", () => {
  it("prepares a verified company case read without changing its source revision", () => {
    const prepared = gateway().prepare(request(), NOW);
    expect(prepared.payload).toEqual(request().payload);
    expect(prepared.caller.principal).toBe("agent:jarvis");
    expect(prepared.target_id).toBe(TARGET.target_id);
    expect(Object.isFrozen(prepared)).toBe(true);
    expect(Object.isFrozen(prepared.payload)).toBe(true);
  });
  it("accepts a report read instead of a case read", () => {
    const raw = request();
    const prepared = gateway().prepare({ ...raw, payload: {
      company_id: raw.payload.company_id, report_id: "report:local-test",
      source_revision: raw.payload.source_revision, view: "owner_report",
    } }, NOW);
    expect(prepared.payload.report_id).toBe("report:local-test");
    expect(prepared.payload.case_id).toBeUndefined();
  });
  it.each([1, 3])("refuses request version %i", schema_version => {
    expectCode(() => gateway().prepare({ ...request(), schema_version }, NOW), "CORE5_FINANCE_INPUT_INVALID");
  });
  it("requires explicit producer v2 and capability support", () => {
    expectCode(() => gateway({ ...TARGET, supported_versions: [1] }).prepare(request(), NOW),
      "CORE5_FINANCE_VERSION_UNSUPPORTED");
    expectCode(() => gateway({ ...TARGET, capabilities: [] }).prepare(request(), NOW),
      "CORE5_FINANCE_VERSION_UNSUPPORTED");
  });
  it("refuses an arbitrary target and preserves disabled-by-default behavior", () => {
    expectCode(() => gateway().prepare({ ...request(), target_id: "https://unregistered.invalid" }, NOW),
      "CORE5_FINANCE_TARGET_UNREGISTERED");
    expectCode(() => gateway(TARGET, false).prepare(request(), NOW), "CORE5_INTEGRATION_DISABLED");
    expectCode(() => new Core5FinanceReadGateway([], new StaticVerifiedIssuer({
      principal: TARGET.principal, workspace: TARGET.workspace, audience: CORE5_INTEGRATION_AUDIENCE,
    }), {}).prepare(request(), NOW), "CORE5_INTEGRATION_DISABLED");
  });
  it("refuses cross-company access even for a verified workspace caller", () => {
    const raw = request();
    expectCode(() => gateway().prepare({ ...raw, payload: { ...raw.payload, company_id: "company:other" } }, NOW),
      "CORE5_FINANCE_COMPANY_SCOPE_DENIED");
  });
  it.each(["principal", "workspace", "audience"])("refuses a foreign %s assertion", field => {
    const raw = request();
    expectCode(() => gateway().prepare({ ...raw, caller: { ...raw.caller, [field]: "foreign" } }, NOW),
      "CORE5_CALLER_UNVERIFIED");
  });
  it("refuses a borrowed human principal, wrong purpose, and expired authority", () => {
    const raw = request();
    expectCode(() => gateway().prepare({ ...raw, caller: { ...raw.caller, principal: "principal:owner" } }, NOW),
      "CORE5_CALLER_UNVERIFIED");
    expectCode(() => gateway().prepare({ ...raw, caller: { ...raw.caller, purpose: "tax.submit" } }, NOW),
      "CORE5_FINANCE_CALLER_SCOPE_DENIED");
    expectCode(() => gateway().prepare(raw, new Date(raw.caller.expiry)), "CORE5_CALLER_EXPIRED");
  });
  it("propagates an existing verifier's revoked-authority refusal", () => {
    const denied = new Core5FinanceReadGateway([TARGET], {
      verify() { throw new JarvisError("CORE5_CALLER_REVOKED"); },
    }, { CORE5_INTEGRATION_ENABLED: "1" });
    expectCode(() => denied.prepare(request(), NOW), "CORE5_CALLER_REVOKED");
  });
  it.each([
    { company_id: "company:local-test", source_revision: "r", view: "reconciliation" },
    { company_id: "company:local-test", case_id: "c", report_id: "r", source_revision: "r", view: "reconciliation" },
    { company_id: "company:local-test", case_id: "c", source_revision: "", view: "reconciliation" },
    { company_id: "company:local-test", case_id: "c", source_revision: "r", view: "payment" },
    { company_id: "company:local-test", case_id: "c", source_revision: "r", view: "reconciliation", amount: 100 },
  ])("rejects malformed or mutation-shaped payload %#", payload => {
    expectCode(() => parseFinanceReadEnvelope({ ...request(), payload }), "CORE5_FINANCE_INPUT_INVALID");
  });
  it("rejects mutation capabilities, self-asserted roles, approval references and collapsed identities", () => {
    const raw = request();
    for (const value of [
      { ...raw, capability: "finance.pay" }, { ...raw, approval_ref: { approval_id: "borrowed" } },
      { ...raw, caller: { ...raw.caller, roles: ["admin"] } }, { ...raw, attempt_id: raw.operation_id },
    ]) expectCode(() => parseFinanceReadEnvelope(value), "CORE5_FINANCE_INPUT_INVALID");
  });
  it("keeps v1's eight capabilities and parser separate from finance v2", () => {
    expect(new Core5CapabilityRegistry({}).list().map(item => item.id)).toEqual([...CORE5_INTEGRATION_CAPABILITIES]);
    expect(CORE5_INTEGRATION_CAPABILITIES).toHaveLength(8);
    expect(CORE5_INTEGRATION_V2_CAPABILITIES).toEqual([...CORE5_INTEGRATION_CAPABILITIES, "finance.read"]);
    const v1 = Object.fromEntries(Object.entries(request()).filter(([key]) => key !== "target_id"));
    expectCode(() => parseCommandEnvelope({ ...v1, schema_version: 1 }), "CORE5_CAPABILITY_UNKNOWN");
  });
  it.each([...CORE5_INTEGRATION_CAPABILITIES])("keeps v1 parser support for %s", capability => {
    const v1 = Object.fromEntries(Object.entries(request()).filter(([key]) => key !== "target_id"));
    expect(parseCommandEnvelope({ ...v1, schema_version: 1, capability }).capability).toBe(capability);
  });
  it("ships v2 machine contract fields without changing the v1 capability contract", () => {
    const v2 = JSON.parse(readFileSync(new URL("../../contracts/integration/v2/finance-read.schema.json", import.meta.url), "utf8"));
    const v1 = JSON.parse(readFileSync(new URL("../../contracts/integration/v1/command-envelope.schema.json", import.meta.url), "utf8"));
    expect(v2).toMatchObject({
      additionalProperties: false,
      properties: {
        schema_version: { const: 2 }, capability: { const: "finance.read" },
        payload: { additionalProperties: false, required: ["company_id", "source_revision", "view"],
          properties: { view: { enum: ["reconciliation", "owner_report", "discrepancy"] } } },
      },
    });
    expect(v1).toMatchObject({
      properties: { schema_version: { const: 1 }, capability: { enum: [...CORE5_INTEGRATION_CAPABILITIES] } },
    });
  });
});
