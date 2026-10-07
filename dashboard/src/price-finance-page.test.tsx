// @vitest-environment jsdom
import { createHash } from "node:crypto";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDashboardClient } from "./api.js";
import { PriceFinancePage } from "./price-finance-page.js";
import type { PriceFinanceReceipt } from "../../src/integration/price-finance-contract.js";

afterEach(cleanup);
const company_id = "company_unit";
const response_body = '{"official_tax_ready":false,"company_data_complete":false,"crm_company_binding":null,'
  + '"payable_coverage":{"crm_links":[]},"amount":"9007199254740993","cash":{"opening_balance":null}}';
const receipt: PriceFinanceReceipt = {
  schema_version: 2, capability: "finance.read", view: "owner_report",
  request: { company_id, period_start: "2026-09-01", period_end: "2026-09-30", view: "owner_report" },
  source_revision: `sha256:${createHash("sha256").update(response_body).digest("hex")}`,
  observed_at: "2026-10-07T11:00:00.000Z", receipt_kind: "response_body_integrity_not_signed",
  freshness: "producer_unverified", response_body,
};
function client() {
  return { ...createDashboardClient(),
    priceFinanceConfig: vi.fn(async () => ({ schema_version: 1, configured: true, company_id } as const)),
    priceFinanceRead: vi.fn(async () => receipt),
  };
}
async function ready() {
  const api = client();
  render(<PriceFinancePage client={api} />);
  await screen.findByRole("button", { name: "Price 원본 조회" });
  fireEvent.change(screen.getByLabelText("시작일"), { target: { value: "2026-09-01" } });
  fireEvent.change(screen.getByLabelText("종료일"), { target: { value: "2026-09-30" } });
  return api;
}
describe("operating Price read work card", () => {
  it("renders byte-identical raw response, source SHA, false readiness and unbound workspace", async () => {
    const api = await ready();
    fireEvent.click(screen.getByRole("button", { name: "Price 원본 조회" }));
    const raw = await screen.findByTestId("price-response-body");
    expect(api.priceFinanceRead).toHaveBeenCalledExactlyOnceWith(receipt.request);
    expect(raw.textContent).toBe(response_body);
    expect(screen.getByTestId("price-response-sha").textContent).toBe(receipt.source_revision);
    expect(document.querySelector("[data-official-tax-ready]")?.getAttribute("data-official-tax-ready")).toBe("false");
    expect(document.querySelector("[data-rt-state]")?.getAttribute("data-rt-state")).toBe("UNBOUND");
  });
  it("does not display an old request response after the user edits its scope", async () => {
    const api = await ready();
    let deliver: (value: PriceFinanceReceipt) => void = () => { throw new Error("flight not initialized"); };
    const flight = new Promise<PriceFinanceReceipt>(resolve => { deliver = resolve; });
    api.priceFinanceRead.mockReturnValueOnce(flight);
    fireEvent.click(screen.getByRole("button", { name: "Price 원본 조회" }));
    fireEvent.change(screen.getByLabelText("조회 종류"), { target: { value: "settlement" } });
    await act(async () => { deliver(receipt); await flight; });
    expect(screen.queryByTestId("price-response-body")).toBeNull();
  });
  it("does not turn a missing producer readiness field into false", async () => {
    const api = await ready();
    const body = '{"items":[],"read_only":true,"live_source_checked":false}';
    api.priceFinanceRead.mockResolvedValueOnce({ ...receipt, view: "discrepancy",
      request: { ...receipt.request, view: "discrepancy" }, response_body: body,
      source_revision: `sha256:${createHash("sha256").update(body).digest("hex")}` });
    fireEvent.change(screen.getByLabelText("조회 종류"), { target: { value: "discrepancy" } });
    fireEvent.click(screen.getByRole("button", { name: "Price 원본 조회" }));
    await screen.findByTestId("price-response-body");
    expect(document.querySelector("[data-official-tax-ready]")?.getAttribute("data-official-tax-ready")).toBe("undefined");
    expect(document.querySelector("[data-rt-state]")).toBeNull();
  });
});
