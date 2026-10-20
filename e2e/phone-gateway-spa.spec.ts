import { AxeBuilder } from "@axe-core/playwright";
import type { Page, TestInfo } from "@playwright/test";
import { productHubSchema } from "../src/dashboard/product-hub-contract.js";
import { copy } from "../dashboard/src/copy.js";
import { expect, test } from "./remote-approval-gateway-fixture.js";

test.describe.configure({ mode: "serial" });

const VIEWPORTS = [
  { name: "390", width: 390, height: 844 },
  { name: "1440", width: 1440, height: 1000 },
] as const;
const QUALITY = ["ready", "degraded", "no_data", "offline", "stale", "unavailable", "incompatible", "expired"];
const PRODUCTS = ["crm", "mail", "price", "second_brain", "messenger", "approvals"] as const;

type PageLedger = {
  readonly consoleErrors: string[];
  readonly rejected: string[];
  readonly readOnlyViolations: string[];
};

/** Every console error and every same-origin response at or above 400 the page itself provoked. */
function ledger(page: Page, origin: string): PageLedger {
  const consoleErrors: string[] = [];
  const rejected: string[] = [];
  const readOnlyViolations: string[] = [];
  page.on("console", message => { if (message.type() === "error") consoleErrors.push(message.text()); });
  page.on("pageerror", error => { consoleErrors.push(error.message); });
  page.on("request", request => {
    const path = new URL(request.url()).pathname;
    if (!["GET", "HEAD"].includes(request.method()) || request.resourceType() === "eventsource"
      || /^\/api\/v1\/(events|overview|tasks|agents|control)(\/|$)/.test(path)) {
      readOnlyViolations.push(`${request.method()} ${path}`);
    }
  });
  page.on("websocket", socket => { readOnlyViolations.push(`WebSocket ${socket.url()}`); });
  page.on("response", response => {
    if (response.url().startsWith(origin) && response.status() >= 400) {
      rejected.push(`${String(response.status())} ${response.request().method()} ${response.url()}`);
    }
  });
  return { consoleErrors, rejected, readOnlyViolations };
}

async function openDocument(page: Page, url: string): Promise<void> {
  const response = await page.goto(url);
  expect(response?.status()).toBe(200);
  expect(response?.headers()["content-type"]).toContain("text/html");
  await expect(page.locator("meta[name='jarvis-phone-mode']")).toHaveAttribute("content", "1");
}

async function assertSurface(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  const nav = page.getByRole("navigation", { name: "주요 메뉴" });
  await expect(nav.getByRole("link")).toHaveCount(5);
  expect(await nav.getByRole("link").evaluateAll(links => links.map(link => link.getAttribute("href"))))
    .toEqual(["/", "/products", "/memory", "/approvals", "/security"]);
  await expect(page.getByRole("status", { name: "실시간" })).toHaveAttribute("data-state", "readonly");
  const box = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth,
  }));
  expect(box.scroll, `${name} horizontal overflow`).toBeLessThanOrEqual(box.client);
  const audit = await new AxeBuilder({ page }).analyze();
  expect(audit.violations.map(item => `${item.id}: ${item.help}`), `${name} axe`).toEqual([]);
  // Keyboard traversal scrolls the document; pin sticky chrome to its initial position for capture.
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: testInfo.outputPath(`${name}.png`), fullPage: true });
}

async function assertProducts(page: Page): Promise<void> {
  const hub = page.getByRole("region", { name: "JARVIS", exact: true });
  await expect(hub).toHaveAttribute("aria-busy", "false");
  await expect(hub.getByRole("article")).toHaveCount(6);
  expect(await hub.getByRole("article").evaluateAll(cards => cards.map(card => card.getAttribute("data-product"))))
    .toEqual(PRODUCTS);
  await expect(hub.getByRole("button")).toHaveCount(1);
  await expect(hub.getByRole("button", { name: "제품 요약 새로고침" })).toBeEnabled();
  await expect(hub.locator("#product-price")).toContainText("화면 준비 중");
  await expect(hub.locator("#product-price a, #product-price button")).toHaveCount(0);
}

async function assertUnknownCounts(page: Page, ids: readonly string[]): Promise<void> {
  for (const id of ids) {
    const summary = page.locator(`[data-product-summary="${id}"]`);
    await expect(summary).toContainText("미확인");
    await expect(summary).not.toContainText(/\d[\d,]*건/);
  }
}

async function keyboardProductLinks(page: Page): Promise<void> {
  await page.keyboard.press("Tab");
  await expect(page.locator(".skip-link")).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.locator("#main-content")).toBeFocused();
  await page.keyboard.press("Tab");
  const refresh = page.getByRole("button", { name: "제품 요약 새로고침" });
  await expect(refresh).toBeFocused();
  expect(await refresh.evaluate(element => element.matches(":focus-visible"))).toBe(true);
  for (const name of ["CRM 화면 열기", "CRM 후보 승인 화면 열기", "메일함 열기", "기억 화면 열기", "메신저 요약 보기", "승인함 열기"]) {
    await page.keyboard.press("Tab");
    const link = page.getByRole("link", { name, exact: true });
    await expect(link).toBeFocused();
    expect(await link.evaluate(element => element.matches(":focus-visible"))).toBe(true);
  }
}

for (const viewport of VIEWPORTS) {
  test(`renders Today read-only from a cold navigation at ${viewport.name}`, async ({ page, gateway, origin }, testInfo) => {
    void gateway;
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    const seen = ledger(page, origin);
    await openDocument(page, `${origin}/`);
    await expect(page.getByRole("heading", { level: 1, name: copy.pages.today })).toBeVisible();
    // The page leaves its loading state with typed application content, never an error page.
    const badge = page.locator(".today-heading .freshness-badge");
    await expect(badge).toBeVisible();
    expect(QUALITY).toContain(await badge.getAttribute("data-freshness"));
    await expect(page.locator(".today-alert")).toHaveAttribute("role", "status");
    await expect(page.getByRole("heading", { level: 2, name: copy.today.sections.now })).toBeVisible();
    await expect(page.getByRole("heading", { level: 2, name: copy.today.sections.decisions })).toBeVisible();
    await expect(page.getByRole("link", { name: "승인 목록 전체 보기" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /Accept|Retry|서명 제출|승인된 요청 실행|실패한 요청 다시 시도/ })).toHaveCount(0);
    await assertProducts(page);
    await assertUnknownCounts(page, ["crm", "mail", "second_brain", "messenger"]);
    await assertSurface(page, testInfo, `today-${viewport.name}`);
    expect(seen.consoleErrors).toEqual([]);
    expect(seen.rejected).toEqual([]);
    expect(seen.readOnlyViolations).toEqual([]);
  });

  test(`renders the existing product hub with keyboard access at ${viewport.name}`, async ({ page, gateway, origin }, testInfo) => {
    void gateway;
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    const seen = ledger(page, origin);
    await openDocument(page, `${origin}/products`);
    await assertProducts(page);
    await assertUnknownCounts(page, ["crm", "mail", "second_brain", "messenger"]);
    await expect(page.locator("#product-price")).toHaveAttribute("data-state", "unconfigured");
    await expect(page.locator("#product-approvals")).toHaveAttribute("data-state", "no_data");
    await expect(page.locator('[data-product-summary="approvals"]')).toContainText("0건");
    await keyboardProductLinks(page);
    await assertSurface(page, testInfo, `products-${viewport.name}`);
    expect(seen.consoleErrors).toEqual([]);
    expect(seen.rejected).toEqual([]);
    expect(seen.readOnlyViolations).toEqual([]);
  });

  test(`keeps all product cards after denied and failed refreshes at ${viewport.name}`, async ({ page, gateway, origin, serveFront }, testInfo) => {
    void gateway;
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    const seen = ledger(page, origin);
    let status = 200;
    // Only this browser's hub response is controlled; cold-route tests above use the real projection.
    await page.route(`${origin}/api/v1/product-hub`, async route => {
      if (status !== 200) {
        await route.fulfill({ status, json: { schema_version: 1, error: {
          code: status === 403 ? "LOCAL_SESSION_REQUIRED" : "INTERNAL_ERROR",
          message: "private-provider-error-must-not-render", request_id: "hub-refusal-fixture",
        } } });
        return;
      }
      // APIRequestContext does not use Chromium's fixture-host resolver rule.
      const response = await route.fetch({ url: `https://127.0.0.1:${String(serveFront.port)}/api/v1/product-hub` });
      expect(response.status()).toBe(200);
      const body = productHubSchema.parse(await response.json());
      body.items[0] = { ...body.items[0], state: "ready", count: 12 };
      await route.fulfill({ response, json: body });
    });
    await openDocument(page, `${origin}/products`);
    await assertProducts(page);
    await expect(page.locator('[data-product-summary="crm"]')).toContainText("12건");
    await assertSurface(page, testInfo, `products-ready-${viewport.name}`);
    for (const failure of [{ status: 403, state: "denied" }, { status: 503, state: "unavailable" }]) {
      status = failure.status;
      await page.getByRole("button", { name: "제품 요약 새로고침" }).click();
      await expect(page.locator(`.product-hub [data-state="${failure.state}"]`)).toHaveCount(6);
      await assertProducts(page);
      await assertUnknownCounts(page, ["crm", "mail", "second_brain", "messenger", "approvals"]);
      await expect(page.locator(".product-hub")).not.toContainText("private-provider-error-must-not-render");
      await assertSurface(page, testInfo, `products-${failure.state}-${viewport.name}`);
    }
    expect(seen.rejected).toEqual([
      `403 GET ${origin}/api/v1/product-hub`, `503 GET ${origin}/api/v1/product-hub`,
    ]);
    // Chromium reports the two deliberately refused resources; every other console/page error fails.
    expect(seen.consoleErrors).toEqual([
      expect.stringMatching(/^Failed to load resource: the server responded with a status of 403 /),
      expect.stringMatching(/^Failed to load resource: the server responded with a status of 503 /),
    ]);
    expect(seen.readOnlyViolations).toEqual([]);
  });

  test(`renders Memory read-only from a cold navigation at ${viewport.name}`, async ({ page, gateway, origin }, testInfo) => {
    void gateway;
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    const seen = ledger(page, origin);
    await openDocument(page, `${origin}/memory`);
    await expect(page.getByRole("heading", { level: 1, name: copy.pages.memory })).toBeVisible();
    const badge = page.locator(".memory-heading .freshness-badge");
    await expect(badge).toBeVisible();
    expect(QUALITY).toContain(await badge.getAttribute("data-freshness"));
    await expect(page.getByRole("heading", { level: 2, name: "검색", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { level: 2, name: "충돌", exact: true })).toBeVisible();
    await expect(page.locator("#memory-candidates-heading")).toHaveCount(0);
    await expect(page.locator("#memory-effects-heading")).toHaveCount(0);
    // A search goes through the gateway with the phone session and CSRF and lands in a typed result state.
    await page.getByLabel("기억 검색").fill("evidence");
    await page.getByRole("button", { name: "기억 검색" }).click();
    await expect(page.getByRole("button", { name: "기억 검색" })).toBeEnabled();
    const searchPanel = page.getByRole("region", { name: "검색", exact: true });
    await expect(searchPanel.locator("[data-result-state], .memory-result-state, .record-list").first()).toBeVisible();
    await expect(page.getByRole("button", { name: /Stage|Prepare|고치기|지우기|JSON 내보내기|명령 준비|확인 준비|거절 준비/ })).toHaveCount(0);
    await assertSurface(page, testInfo, `memory-${viewport.name}`);
    expect(seen.consoleErrors).toEqual([]);
    expect(seen.rejected).toEqual([]);
  });
}

test("keeps forbidden routes closed for a navigating browser", async ({ page, gateway, origin }) => {
  void gateway;
  await openDocument(page, `${origin}/`);
  await expect(page.getByRole("heading", { level: 1, name: copy.pages.today })).toBeVisible();
  // Approvals is now an explicitly allowed shell, not permission to proxy local control APIs.
  await openDocument(page, `${origin}/approvals`);
  for (const path of ["/terminal", "/api/v1/agents/x/logs?limit=1", "/api/v1/session", "/overview",
    "/tasks", "/agents", "/workboard", "/api/v1/control/requests", "/api/v1/events"]) {
    const response = await page.goto(`${origin}${path}`);
    expect(response?.status(), path).toBe(404);
    expect(await response?.text(), path).toContain("PHONE_ROUTE_NOT_FOUND");
  }
  for (const path of ["/api/v1/today", "/api/v1/product-hub"]) {
    const api = await page.goto(`${origin}${path}`);
    expect(api?.status()).toBe(403);
    expect(await api?.text()).toContain("PHONE_CSRF_REQUIRED");
  }
});
