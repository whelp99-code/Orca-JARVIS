import { describe, expect, it } from "vitest";
import { consumeNativeOwnerReport } from "../../src/integration/native-owner-report.js";

const binding = { company_id: "company:native-fixture", start: "2026-09-01", end: "2026-09-30",
  source_revision: `sha256:${"a".repeat(64)}` };
function report() {
  return {
    company_id: binding.company_id, period: { start: binding.start, end: binding.end },
    source_revision: binding.source_revision, native_contract: "price.owner-report/2",
    basis: "posted_validation_ledger",
    read_identity: { mode: "native_membership_non_worker", role: "viewer", worker: false },
    cash: { received: 0, paid: 0, net_movement: 0, opening_balance: null, closing_balance: null,
      opening_balance_verified: false },
    journal_ids: [],
    payable_coverage: { bank_cutoff_verified: false, purchase_obligations: [{
      order_cash_residual: null, unresolved_cash_outflows: 125,
      unresolved_cash_event_ids: ["native:unknown-cash"], net_linked_cash: 450,
      payable_today: null, confirmed: false, cash_coverage_complete: false,
    }] },
    official_tax_ready: false, company_data_complete: false,
  };
}
describe("native owner report consumption", () => {
  it("retains unknown balances and unclassified cash without arithmetic or a journal effect", () => {
    const result = consumeNativeOwnerReport(report(), binding);
    expect(result.cash.opening_balance).toBeNull();
    expect(result.cash.closing_balance).toBeNull();
    expect(result.payable_coverage.purchase_obligations[0]).toMatchObject({
      order_cash_residual: null, unresolved_cash_outflows: 125, net_linked_cash: 450,
    });
    expect(result.journal_ids).toEqual([]);
  });
  it.each(["company_id", "source_revision", "start", "end"])("refuses a different native %s binding", field => {
    const expected = { ...binding, [field]: field === "source_revision" ? `sha256:${"b".repeat(64)}`
      : field === "company_id" ? "company:foreign" : "2026-10-01" };
    expect(() => consumeNativeOwnerReport(report(), expected))
      .toThrowError(expect.objectContaining({ code: "CORE5_NATIVE_REPORT_BINDING_MISMATCH" }));
  });
  it.each([
    { order_cash_residual: 525 }, { cash_coverage_complete: true },
    { unresolved_cash_outflows: "125" }, { unresolved_cash_outflows: Number.MAX_SAFE_INTEGER + 1 },
  ])("refuses a promoted or lossy unknown-cash result %#", change => {
    const value = report(), row = value.payable_coverage.purchase_obligations[0];
    expect(() => consumeNativeOwnerReport({ ...value, payable_coverage: {
      ...value.payable_coverage, purchase_obligations: [{ ...row, ...change }],
    } }, binding)).toThrowError(expect.objectContaining({ code: "CORE5_NATIVE_REPORT_INVALID" }));
  });
  it.each(["official_tax_ready", "company_data_complete"])("does not promote %s", flag => {
    expect(() => consumeNativeOwnerReport({ ...report(), [flag]: true }, binding))
      .toThrowError(expect.objectContaining({ code: "CORE5_NATIVE_REPORT_INVALID" }));
  });
  it("refuses worker identity", () => {
    const value = report();
    expect(() => consumeNativeOwnerReport({ ...value, read_identity: { ...value.read_identity, worker: true } }, binding))
      .toThrowError(expect.objectContaining({ code: "CORE5_NATIVE_REPORT_INVALID" }));
  });
});
