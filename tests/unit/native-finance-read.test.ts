import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { NativeFinanceReader } from "../../src/integration/native-finance-read.js";

const AT = new Date("2026-10-06T15:00:00.000Z");
const request = {
  company_id: "company_unit_fixture", period_start: "2026-09-01", period_end: "2026-09-30",
  view: "owner_report",
} as const;
const fixture = {
  response_body: JSON.stringify({
    company_id: request.company_id, native_contract: "price.owner-report/2",
    source_revision: `sha256:${"a".repeat(64)}`,
    period: { start: request.period_start, end: request.period_end }, basis: "posted_validation_ledger",
    read_identity: { mode: "native_membership_non_worker", role: "viewer", worker: false },
    cash: { received: 0, paid: 0, net_movement: 0, opening_balance: null, closing_balance: null,
      opening_balance_verified: false },
    journal_ids: [], official_tax_ready: false, company_data_complete: false,
    payable_coverage: {
      allocations: [], balances: [], accounting_posted: false, confirmed: false,
      bank_cutoff_verified: false, as_of: null, stale_event_ids: [],
      purchase_obligations: [{
        ordered: 1100, invoiced: 660, unbilled: 440, economic_amount: 1100,
        invoice_allocated: 300, invoice_remaining: 360,
        advance_outflows: 200, advance_applied: 0,
        order_payment_outflows: 300, order_payment_applied: 300, fee_outflows: 10, refund_inflows: 50,
        order_cash_residual: null, unresolved_cash_outflows: 125,
        unresolved_cash_event_ids: ["unit:unknown-cash"], net_linked_cash: 450,
        payable_today: null, confirmed: false, cash_coverage_complete: false,
      }],
    },
  }),
};
function setup(body: string = fixture.response_body, status = 200) {
  let fence = "local:one";
  const get = vi.fn(async () => ({ status, body }));
  const reader = new NativeFinanceReader(request.company_id, { get }, () => fence, () => AT);
  return { reader, get, changeFence: () => { fence = "local:two"; } };
}

describe("native finance read contract", () => {
  it("sends exact native GET keys and derives J1 identities from the raw response", async () => {
    const { reader, get } = setup();
    const result = await reader.read(request);
    expect(get).toHaveBeenCalledExactlyOnceWith({
      method: "GET", path: `/api/companies/${request.company_id}/owner/reports`,
      query: { start: request.period_start, end: request.period_end },
    });
    expect(result.report_id).toBe(`sha256:${createHash("sha256").update([
      request.company_id, request.period_start, request.period_end, request.view,
    ].join("|")).digest("hex")}`);
    expect(result.source_revision).toBe(`sha256:${createHash("sha256").update(fixture.response_body).digest("hex")}`);
    expect(result.observed_at).toBe(AT.toISOString());
    expect(result.coverage).toBe("requested-period");
    expect(result.freshness).toBe("producer_unverified");
    expect(result.response_body).toBe(fixture.response_body);
  });
  it.each([
    { company_id: "foreign" },
    { period_start: "2026-10-01" },
    { period_end: "" },
    { period_start: "2026-02-30" },
    { view: "reconcile" },
    { report_id: "invented-native-ref" },
    { source_revision: "caller-assertion" },
    { method: "POST" },
    { target_url: "https://foreign.invalid" },
  ])("refuses invalid or cross-company input before transport %#", async change => {
    const { reader, get } = setup();
    await expect(reader.read({ ...request, ...change })).rejects.toBeInstanceOf(Error);
    expect(get).not.toHaveBeenCalled();
  });
  it("discards a successful native result after local delivery binding changes", async () => {
    const { reader, get, changeFence } = setup();
    get.mockImplementationOnce(async () => {
      changeFence();
      return { status: 200, body: fixture.response_body };
    });
    await expect(reader.read(request)).rejects.toMatchObject({ code: "CORE5_NATIVE_READ_FENCE_CHANGED" });
    expect(get).toHaveBeenCalledTimes(1);
  });
  it.each([401, 403, 404, 409, 422, 500])("does not convert native %s into an empty result or retry", async status => {
    const { reader, get } = setup('{"items":[]}', status);
    await expect(reader.read(request)).rejects.toMatchObject({ code: "CORE5_NATIVE_READ_REFUSED" });
    expect(get).toHaveBeenCalledTimes(1);
  });
  it("retains exact monetary strings and the native collection scope for discrepancies", async () => {
    const body = JSON.stringify({
      items: [{ id: "native:quarantine", amounts: { incoming: { gross: "9007199254740993" } }, freshness: "UNKNOWN" }],
      read_only: true, live_source_checked: false,
    });
    const { reader, get } = setup(body);
    const result = await reader.read({ ...request, view: "discrepancy" });
    expect(get).toHaveBeenCalledExactlyOnceWith({
      method: "GET", path: `/api/companies/${request.company_id}/discrepancies`, query: {},
    });
    expect(result.coverage).toBe("company-wide");
    expect(result.data).toEqual(JSON.parse(body));
    expect(result.source_revision).toBe(`sha256:${createHash("sha256").update(body).digest("hex")}`);
  });
  it("retains settlement blockers and source-bound RT identity without confirming money", async () => {
    const raw = z.object({ payable_coverage: z.record(z.string(), z.unknown()) }).parse(JSON.parse(fixture.response_body));
    const coverage = {
      ...raw.payable_coverage,
      crm_links: [{ id: "native:candidate", state: "UNAPPROVED", confirmed_by: null }],
    };
    const { reader, get } = setup(JSON.stringify(coverage));
    const result = await reader.read({ ...request, view: "settlement" });
    expect(get).toHaveBeenCalledExactlyOnceWith({
      method: "GET", path: `/api/companies/${request.company_id}/event-settlements`, query: {},
    });
    expect(result.coverage).toBe("company-wide");
    expect(result.data).toMatchObject({
      confirmed: false, bank_cutoff_verified: false,
      crm_links: coverage.crm_links,
      purchase_obligations: [{
        unresolved_cash_outflows: 125, order_cash_residual: null, payable_today: null,
      }],
    });
  });
  it.each(["{", "null", '{"read_only":false,"live_source_checked":true,"items":[]}'])("refuses invalid collection response %s", async body => {
    const { reader } = setup(body);
    await expect(reader.read({ ...request, view: "discrepancy" }))
      .rejects.toMatchObject({ code: "CORE5_NATIVE_READ_RESPONSE_INVALID" });
  });
  it("refuses a different company returned in a successful owner response", async () => {
    const body = fixture.response_body.replace(request.company_id, "company:foreign");
    const { reader } = setup(body);
    await expect(reader.read(request)).rejects.toMatchObject({ code: "CORE5_NATIVE_REPORT_BINDING_MISMATCH" });
  });
  it("refuses promoted unknown cash even when it arrived over successful settlement GET", async () => {
    const parsed = z.object({ payable_coverage: z.record(z.string(), z.unknown()) }).parse(JSON.parse(fixture.response_body));
    const body = JSON.stringify(parsed.payable_coverage).replace('"order_cash_residual":null', '"order_cash_residual":525');
    const { reader } = setup(body);
    await expect(reader.read({ ...request, view: "settlement" }))
      .rejects.toMatchObject({ code: "CORE5_NATIVE_READ_RESPONSE_INVALID" });
  });
  it("refuses a lossy native integer instead of rounding a settlement balance", async () => {
    const parsed = z.object({ payable_coverage: z.record(z.string(), z.unknown()) }).parse(JSON.parse(fixture.response_body));
    const body = JSON.stringify({ ...parsed.payable_coverage, balances: [{ gross: 1, allocated: 0, remaining: 1 }] })
      .replace('"gross":1', '"gross":9007199254740993');
    const { reader } = setup(body);
    await expect(reader.read({ ...request, view: "settlement" }))
      .rejects.toMatchObject({ code: "CORE5_NATIVE_READ_RESPONSE_INVALID" });
  });
});
