import { createHash } from "node:crypto";
import { expect, test } from "@playwright/test";
import { priceFinanceReceiptSchema } from "../src/integration/price-finance-contract.js";
import { mailCandidatesSummarySchema } from "../src/integration/mail-candidates-contract.js";

const viewports = [{ width: 1440, height: 1000 }, { width: 390, height: 844 }] as const;
const company_id = "company_readable_fixture";
const observed_at = "2026-10-09T00:00:00.000Z";
const workspace_id = "75c2b088-e5aa-5396-9e9e-6dfd77e50048";
const response_body = JSON.stringify({
  official_tax_ready: false, company_data_complete: false, crm_company_binding: null,
  payable_coverage: { crm_links: [] }, cash: { received: 1250000, paid: 950000, net_movement: 300000 },
});
const receipt = priceFinanceReceiptSchema.parse({
  schema_version: 2, capability: "finance.read", view: "owner_report",
  request: { company_id, period_start: "2026-09-01", period_end: "2026-09-30", view: "owner_report" },
  source_revision: `sha256:${createHash("sha256").update(response_body).digest("hex")}`,
  observed_at, receipt_kind: "response_body_integrity_not_signed", freshness: "producer_unverified", response_body,
});
const candidates = mailCandidatesSummarySchema.parse({
  schema_version: 1, proof_level: "native-read", authority: "none", observed_at,
  crm: { state: "read", workspace_id, candidate_count: 1,
    recent: [{ id: "synthetic-candidate", status: "CANDIDATE", confirmed: false,
      freshness: "producer_unverified", createdAt: "2026-10-08T00:00:00.000Z" }] },
  sb: { state: "read", workspace_id, candidate_count: 1 },
});

test.describe.configure({ mode: "serial" });

test("native API fixtures drive readable summaries at 1440 and 390", async ({ page, baseURL }, testInfo) => {
  if (baseURL === undefined) throw new Error("baseURL required");
  await page.route("**/api/v1/finance-read/config", route => route.fulfill({ json: {
    schema_version: 1, configured: true, company_id,
  } }));
  await page.route("**/api/v1/finance-read/company-binding", route => route.fulfill({ json: {
    schema_version: 1, company_id, source_revision: `sha256:${"a".repeat(64)}`, observed_at,
    freshness: "producer_unverified", receipt_kind: "response_body_integrity_not_signed",
    response_body: '{"candidate":null,"confirmed_connection":false}',
    data: { candidate: null, confirmed_connection: false },
  } }));
  await page.route("**/api/v1/finance-read?*", route => {
    const url = new URL(route.request().url());
    expect(route.request().method()).toBe("GET");
    expect(Object.fromEntries(url.searchParams)).toEqual(receipt.request);
    return route.fulfill({ json: receipt });
  });
  await page.route("**/api/v1/mail-candidates", route => route.fulfill({ json: candidates }));
  for (const viewport of viewports) {
    await page.setViewportSize(viewport);
    await page.goto(new URL("/finance-read", baseURL).toString());
    await page.getByLabel("시작일").fill(receipt.request.period_start);
    await page.getByLabel("종료일").fill(receipt.request.period_end);
    await page.getByRole("button", { name: "Price 원본 조회" }).click();
    const price = page.getByTestId("price-readable-summary");
    await expect(price).toBeVisible();
    await expect(price).toContainText("받은 금액₩1,250,000");
    await expect(price).toContainText("지급 금액₩950,000");
    await expect(price).toContainText("순현금 변동₩300,000");
    await expect(price).toContainText("다음 행동확인 필요");
    await expect(page.getByTestId("crm-readable-summary")).toHaveText(
      "확인 필요 1건 · 가장 오래된 것 1일 · 다음 행동: CRM에서 확인",
    );
    await expect(page.locator('[data-proof-level="native-read"]')).toBeVisible();
    await expect(page.getByText("LOCAL_ONLY · 격리 fixture", { exact: false })).toHaveCount(0);
    // Mask rendered values by element, including Korean amounts, ISO input values and raw JSON.
    // Assertions above operate on the unmodified DOM; only the attached image is redacted.
    const screenshot = testInfo.outputPath(`finance-readable-${String(viewport.width)}.png`);
    await page.screenshot({ path: screenshot, fullPage: true, mask: [page.locator(
      'time, input[type="date"], code, pre, .identity-list dd, [data-testid="price-readable-summary"] p',
    )] });
    await testInfo.attach(`finance-readable-${String(viewport.width)}`, { path: screenshot, contentType: "image/png" });
  }
});
