import { AxeBuilder } from "@axe-core/playwright";
import type { Page, TestInfo } from "@playwright/test";
import { expect, test } from "./remote-approval-gateway-fixture.js";

test.describe.configure({ mode: "serial" });

const VIEWPORTS = [
  { name: "390", width: 390, height: 844 },
  { name: "1440", width: 1440, height: 1000 },
] as const;
const QUALITY = ["ready", "degraded", "no_data", "offline", "stale", "unavailable", "incompatible", "expired"];

type PageLedger = {
  readonly consoleErrors: string[];
  readonly rejected: string[];
};

/** Every console error and every same-origin response at or above 400 the page itself provoked. */
function ledger(page: Page, origin: string): PageLedger {
  const consoleErrors: string[] = [];
  const rejected: string[] = [];
  page.on("console", message => { if (message.type() === "error") consoleErrors.push(message.text()); });
  page.on("pageerror", error => { consoleErrors.push(error.message); });
  page.on("response", response => {
    if (response.url().startsWith(origin) && response.status() >= 400) {
      rejected.push(`${String(response.status())} ${response.request().method()} ${response.url()}`);
    }
  });
  return { consoleErrors, rejected };
}

async function openDocument(page: Page, url: string): Promise<void> {
  const response = await page.goto(url);
  expect(response?.status()).toBe(200);
  expect(response?.headers()["content-type"]).toContain("text/html");
  await expect(page.locator("meta[name='jarvis-phone-mode']")).toHaveAttribute("content", "1");
}

async function assertSurface(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  const nav = page.getByRole("navigation", { name: "주요 메뉴" });
  await expect(nav.getByRole("link")).toHaveCount(3);
  await expect(page.getByRole("status", { name: "실시간" })).toHaveAttribute("data-state", "readonly");
  const box = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth,
  }));
  expect(box.scroll, `${name} horizontal overflow`).toBeLessThanOrEqual(box.client);
  const audit = await new AxeBuilder({ page }).analyze();
  expect(audit.violations.map(item => `${item.id}: ${item.help}`), `${name} axe`).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath(`${name}.png`), fullPage: true });
}

for (const viewport of VIEWPORTS) {
  test(`renders Today read-only from a cold navigation at ${viewport.name}`, async ({ page, gateway, origin }, testInfo) => {
    void gateway;
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    const seen = ledger(page, origin);
    await openDocument(page, `${origin}/`);
    await expect(page.getByRole("heading", { level: 1, name: "Today" })).toBeVisible();
    // The page leaves its loading state with typed application content, never an error page.
    const badge = page.locator(".today-heading .freshness-badge");
    await expect(badge).toBeVisible();
    expect(QUALITY).toContain(await badge.getAttribute("data-freshness"));
    await expect(page.locator(".today-alert")).toHaveAttribute("role", "status");
    await expect(page.getByRole("heading", { level: 2, name: "NOW" })).toBeVisible();
    await expect(page.getByRole("heading", { level: 2, name: "DECISIONS" })).toBeVisible();
    await expect(page.getByRole("link", { name: "승인 목록 전체 보기" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /Accept|Retry/ })).toHaveCount(0);
    await assertSurface(page, testInfo, `today-${viewport.name}`);
    expect(seen.consoleErrors).toEqual([]);
    expect(seen.rejected).toEqual([]);
  });

  test(`renders Memory read-only from a cold navigation at ${viewport.name}`, async ({ page, gateway, origin }, testInfo) => {
    void gateway;
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    const seen = ledger(page, origin);
    await openDocument(page, `${origin}/memory`);
    await expect(page.getByRole("heading", { level: 1, name: "Memory" })).toBeVisible();
    const badge = page.locator(".memory-heading .freshness-badge");
    await expect(badge).toBeVisible();
    expect(QUALITY).toContain(await badge.getAttribute("data-freshness"));
    await expect(page.getByRole("heading", { level: 2, name: "Search" })).toBeVisible();
    await expect(page.getByRole("heading", { level: 2, name: "Conflicts" })).toBeVisible();
    await expect(page.getByRole("heading", { level: 2, name: "Candidates" })).toHaveCount(0);
    await expect(page.getByRole("heading", { level: 2, name: "Effects and privacy receipts" })).toHaveCount(0);
    // A search goes through the gateway with the phone session and CSRF and lands in a typed result state.
    await page.getByLabel("Memory query").fill("evidence");
    await page.getByRole("button", { name: "Search memory" }).click();
    await expect(page.getByRole("button", { name: "Search memory" })).toBeEnabled();
    const searchPanel = page.getByRole("region", { name: "Search" });
    await expect(searchPanel.locator("[data-result-state], .memory-result-state, .record-list").first()).toBeVisible();
    await expect(page.getByRole("button", { name: /Stage|Prepare/ })).toHaveCount(0);
    await assertSurface(page, testInfo, `memory-${viewport.name}`);
    expect(seen.consoleErrors).toEqual([]);
    expect(seen.rejected).toEqual([]);
  });
}

test("keeps forbidden routes closed for a navigating browser", async ({ page, gateway, origin }) => {
  void gateway;
  await openDocument(page, `${origin}/`);
  await expect(page.getByRole("heading", { level: 1, name: "Today" })).toBeVisible();
  for (const path of ["/terminal", "/api/v1/agents/x/logs?limit=1", "/api/v1/session", "/overview", "/approvals"]) {
    const response = await page.goto(`${origin}${path}`);
    expect(response?.status(), path).toBe(404);
    expect(await response?.text(), path).toContain("PHONE_ROUTE_NOT_FOUND");
  }
  const api = await page.goto(`${origin}/api/v1/today`);
  expect(api?.status()).toBe(403);
  expect(await api?.text()).toContain("PHONE_CSRF_REQUIRED");
});
