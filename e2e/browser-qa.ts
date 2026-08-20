import { AxeBuilder } from "@axe-core/playwright";
import { expect, type Page, type TestInfo } from "@playwright/test";

export type ConsoleBag = {
  readonly errors: string[];
};

export function attachConsole(page: Page): ConsoleBag {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    if (/Failed to load resource: the server responded with a status of 4\d\d/u.test(message.text())) return;
    errors.push(message.text());
  });
  page.on("pageerror", (error) => {
    errors.push(error.message);
  });
  return { errors };
}

export async function waitLive(page: Page): Promise<void> {
  await expect(page).toHaveTitle("JARVIS Control Center");
  await expect(page.getByRole("status", { name: "Live updates" })).toHaveText("Connected");
}

export async function assertNoHorizontalOverflow(page: Page): Promise<void> {
  const box = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    client: document.documentElement.clientWidth,
  }));
  expect(box.scroll, `horizontal overflow ${String(box.scroll)}>${String(box.client)}`).toBeLessThanOrEqual(box.client);
}

export async function assertAxeClean(page: Page): Promise<void> {
  const results = await new AxeBuilder({ page }).analyze();
  const serious = results.violations.filter((violation) => (
    violation.impact === "serious" || violation.impact === "critical"
  ));
  expect(serious).toEqual([]);
}

export async function capture(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  await page.screenshot({ path: testInfo.outputPath(`${name}.png`), fullPage: true });
}

export async function assertNoClip(page: Page, text: string): Promise<void> {
  const locator = page.getByText(text).first();
  await expect(locator).toBeVisible();
  const overflow = await locator.evaluate((node) => {
    const element = node instanceof HTMLElement ? node : node.parentElement;
    if (element === null) return true;
    return element.scrollWidth > element.clientWidth || element.scrollHeight > element.clientHeight + 1;
  });
  expect(overflow).toBe(false);
}
