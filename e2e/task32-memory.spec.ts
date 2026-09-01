import { AxeBuilder } from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

const VIEWPORTS = [
  { width: 1440, height: 1024 },
  { width: 640, height: 900 },
  { width: 375, height: 812 },
] as const;

test("Memory route stays private, accessible, and overflow-safe at every accepted viewport", async ({ page }, testInfo) => {
  const target = process.env.TASK32_BASE_URL === undefined ? "/memory"
    : new URL("/memory", process.env.TASK32_BASE_URL).toString();
  for (const viewport of VIEWPORTS) {
    // Given
    await page.setViewportSize(viewport);
    // When
    await page.goto(target);
    await expect(page.getByRole("heading", { level: 1, name: "Memory" })).toBeVisible();
    await expect(page.getByRole("link", { name: "기억" })).toHaveAttribute("aria-current", "page");
    // Then
    await expect(page.getByLabel("Memory query")).toHaveAttribute("autocomplete", "off");
    await page.getByLabel("Memory query").fill("canary-free fictional memory query");
    expect(new URL(page.url()).search).toBe("");
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBe(0);
    const accessibility = await new AxeBuilder({ page }).analyze();
    expect(accessibility.violations.filter(item => ["serious", "critical"].includes(item.impact ?? ""))).toEqual([]);
    const screenshot = testInfo.outputPath(`memory-${String(viewport.width)}.png`);
    await page.screenshot({ path: screenshot, fullPage: true });
    await testInfo.attach(`memory-${String(viewport.width)}`, { path: screenshot,
      contentType: "image/png" });
  }
});
