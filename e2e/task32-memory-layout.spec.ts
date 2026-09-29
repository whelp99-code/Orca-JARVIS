import { expect, test } from "@playwright/test";
import { MemorySurfaceFixture, type ProviderMode } from "./task32-memory-fixture.js";
import { CJK_START, MemoryPageDriver, VIEWPORTS } from "./task32-memory-page.js";

/** Layout, CJK, and keyboard coverage of the Memory route on the in-repo fixture. */
let fixture: MemorySurfaceFixture;
test.beforeEach(async () => { fixture = await MemorySurfaceFixture.start(); });
test.afterEach(async () => { await fixture.stop(); });

test("provider read states render cleanly at every accepted viewport", async ({ page }, testInfo) => {
  test.setTimeout(90_000);
  const memory = new MemoryPageDriver(page, fixture);
  for (const mode of ["current", "no_data", "stale", "offline"] as const satisfies readonly ProviderMode[]) {
    await fixture.mode(mode);
    for (const viewport of VIEWPORTS) {
      await page.setViewportSize(viewport);
      await memory.open();
      await memory.search();
      const label = `${mode}@${String(viewport.width)}`;
      if (mode === "current") await expect(page.getByRole("button", { name: /Project Atlas/ })).toBeVisible();
      if (mode === "no_data") await expect(page.getByText("No visible memory records")).toBeVisible();
      if (mode === "stale") {
        await expect(page.getByText(/stale evidence/).first()).toBeVisible();
        await expect(memory.badge()).toHaveText("stale");
      }
      if (mode === "offline") {
        await expect(page.getByText(/provider offline/).first()).toBeVisible();
        await expect(page.getByRole("region", { name: "Conflicts" }).getByText("No unresolved conflicts")).toHaveCount(0);
      }
      expect(await memory.overflow(), `${label} overflow`).toBe(0);
      await memory.axeClean(label);
      await page.screenshot({ path: testInfo.outputPath(`09-${label}.png`), fullPage: true });
    }
  }
});

test("CJK long text wraps at 390px without mid-syllable breaks or overflow", async ({ page }, testInfo) => {
  const memory = new MemoryPageDriver(page, fixture);
  await page.setViewportSize({ width: 390, height: 844 });
  await memory.open();
  await memory.search();
  await page.getByRole("button", { name: new RegExp(CJK_START) }).click();
  const heading = memory.detail().getByRole("heading", { level: 3 });
  await expect(heading).toContainText(CJK_START);
  const style = await heading.evaluate(node => {
    const computed = globalThis.getComputedStyle(node);
    return { wordBreak: computed.wordBreak, overflowWrap: computed.overflowWrap, whiteSpace: computed.whiteSpace };
  });
  expect(style.wordBreak).toBe("keep-all");
  expect(style.overflowWrap).toBe("anywhere");
  expect(style.whiteSpace).not.toBe("nowrap");
  expect(await memory.overflow()).toBe(0);
  const reviews = page.getByRole("button", { name: "Review candidate" });
  await reviews.nth(0).click();
  await expect(page.locator(".memory-review-text")).toBeVisible();
  if (!(await page.getByText("한국어 후보").isVisible())) await reviews.nth(1).click();
  await expect(page.getByText("한국어 후보")).toBeVisible();
  expect(await memory.overflow()).toBe(0);
  await memory.axeClean("cjk@390");
  await page.screenshot({ path: testInfo.outputPath("10-cjk-390.png"), fullPage: true });
});

test("Memory search and correction are operable with the keyboard alone", async ({ page }, testInfo) => {
  const memory = new MemoryPageDriver(page, fixture);
  await memory.open();
  const query = page.getByLabel("Memory query");
  for (let press = 0; press < 40; press += 1) {
    if (await query.evaluate(node => node === document.activeElement)) break;
    await page.keyboard.press("Tab");
  }
  await expect(query).toBeFocused();
  await page.keyboard.type("evidence");
  await page.keyboard.press("Enter");
  const first = page.getByRole("button", { name: /Project Atlas/ });
  await expect(first).toBeVisible();
  await page.keyboard.press("Tab"); await page.keyboard.press("Tab");
  await expect(first).toBeFocused();
  await page.keyboard.press("Enter");
  const replacement = page.getByLabel("Replacement");
  for (let press = 0; press < 40; press += 1) {
    if (await replacement.evaluate(node => node === document.activeElement)) break;
    await page.keyboard.press("Tab");
  }
  await expect(replacement).toBeFocused();
  await page.keyboard.type("Keyboard correction draft");
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Stage correction" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(memory.status()).toHaveText("Pending owner approval");
  expect(await memory.commandCount("memory.outbox.dispatch")).toBe(1);
  await page.screenshot({ path: testInfo.outputPath("11-keyboard-1440.png"), fullPage: true });
});
