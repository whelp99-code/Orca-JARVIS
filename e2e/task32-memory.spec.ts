import { AxeBuilder } from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { MemorySurfaceFixture } from "./task32-memory-fixture.js";
import { VIEWPORTS } from "./task32-memory-page.js";

const QUERY = "canary-free fictional memory query";

let fixture: MemorySurfaceFixture;
test.beforeAll(async () => { fixture = await MemorySurfaceFixture.start(); });
test.afterAll(async () => { await fixture.stop(); });

async function submitSearch(page: Page): Promise<void> {
  await page.getByLabel("Memory query").fill(QUERY);
  await page.getByRole("button", { name: "Search memory" }).click();
  await expect(page.getByRole("button", { name: /Project Atlas/ })).toBeVisible();
}

test("Memory route stays private, accessible, and overflow-safe at every accepted viewport", async ({ page }, testInfo) => {
  const requestUrls: string[] = [];
  page.on("request", request => { requestUrls.push(request.url()); });
  await page.clock.install({ time: await fixture.now() });
  for (const viewport of VIEWPORTS) {
    // Given the built dashboard against the isolated fixture at this viewport
    await page.setViewportSize(viewport);
    await page.goto(new URL("/memory", fixture.app).toString());
    await expect(page.getByRole("heading", { level: 1, name: "Memory" })).toBeVisible();
    await expect(page.getByRole("link", { name: "기억" })).toHaveAttribute("aria-current", "page");
    await expect(page.getByLabel("Memory query")).toHaveAttribute("autocomplete", "off");
    // When the owner actually submits a query and opens a record
    await submitSearch(page);
    await page.getByRole("button", { name: /Project Atlas/ }).click();
    await expect(page.getByRole("term").filter({ hasText: "Citation" })).toBeVisible();
    // Then the query never lands in the URL, history, storage, or any request URL
    expect(new URL(page.url()).search).toBe("");
    expect(new URL(page.url()).hash).toBe("");
    const storage = await page.evaluate(() => ({ local: Object.keys(localStorage), session: Object.keys(sessionStorage),
      history: JSON.stringify(history.state) }));
    expect(storage.local).toEqual([]);
    expect(storage.session).toEqual([]);
    expect(storage.history).not.toContain(QUERY);
    expect(requestUrls.filter(url => url.includes(encodeURIComponent(QUERY)) || url.includes(QUERY))).toEqual([]);
    // And the surface is overflow-free with no axe violation at any impact
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow, `overflow at ${String(viewport.width)}`).toBe(0);
    const accessibility = await new AxeBuilder({ page }).analyze();
    expect(accessibility.violations.map(item => `${item.id}: ${item.help}`)).toEqual([]);
    const screenshot = testInfo.outputPath(`memory-${String(viewport.width)}.png`);
    await page.screenshot({ path: screenshot, fullPage: true });
    await testInfo.attach(`memory-${String(viewport.width)}`, { path: screenshot, contentType: "image/png" });
  }
});
