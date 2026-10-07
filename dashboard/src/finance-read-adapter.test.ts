import { describe, expect, it } from "vitest";
import { createIsolatedFinanceReadAdapter } from "./finance-read-adapter.js";

const AT = new Date("2026-10-06T00:00:00.000Z");
function setup() {
  let now = AT;
  const adapter = createIsolatedFinanceReadAdapter(() => now);
  const payload = {
    company_id: adapter.company_id, case_id: "case:fixture",
    source_revision: adapter.source_revision, view: "reconciliation",
  } as const;
  return { adapter, payload, expire: () => { now = new Date(AT.getTime() + 60 * 60 * 1_000); } };
}

describe("isolated finance read adapter", () => {
  it("uses the actual gateway and retains fixture proof and request identities", () => {
    const { adapter, payload } = setup();
    const raw = adapter.request(payload, 2);
    const prepared = adapter.prepare(raw);
    expect(adapter.proof_level).toBe("isolated-fixture");
    expect(prepared.payload).toEqual(payload);
    expect(new Set([prepared.operation_id, prepared.attempt_id, prepared.lease_fence]).size).toBe(3);
    expect(Object.isFrozen(prepared)).toBe(true);
  });
  it.each([
    ["company", { company_id: "company:foreign" }, 2, "CORE5_FINANCE_COMPANY_SCOPE_DENIED"],
    ["revision", { source_revision: "fixture:changed" }, 2, "CORE5_FINANCE_SOURCE_STALE"],
    ["version", {}, 1, "CORE5_FINANCE_INPUT_INVALID"],
  ] as const)("refuses mismatched %s without returning a prepared request", (_name, change, version, code) => {
    const { adapter, payload } = setup();
    expect(() => adapter.prepare(adapter.request({ ...payload, ...change }, version)))
      .toThrowError(expect.objectContaining({ code }));
  });
  it("refuses fixture authority at the exact expiry boundary", () => {
    const { adapter, payload, expire } = setup();
    const raw = adapter.request(payload, 2);
    expire();
    expect(() => adapter.prepare(raw)).toThrowError(expect.objectContaining({ code: "CORE5_CALLER_EXPIRED" }));
  });
  it("refuses human authority and mutation capability through the same gateway", () => {
    const { adapter, payload } = setup();
    const raw = adapter.request(payload, 2) as Record<string, unknown>;
    expect(() => adapter.prepare({ ...raw, capability: "finance.pay" }))
      .toThrowError(expect.objectContaining({ code: "CORE5_FINANCE_INPUT_INVALID" }));
    expect(() => adapter.prepare({ ...raw, caller: {
      ...(raw["caller"] as Record<string, unknown>), principal: "principal:owner",
    } })).toThrowError(expect.objectContaining({ code: "CORE5_CALLER_UNVERIFIED" }));
  });
});
