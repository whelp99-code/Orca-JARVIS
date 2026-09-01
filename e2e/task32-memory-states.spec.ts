import { AxeBuilder } from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

/**
 * Real-state Memory matrix. Every target is a separately launched built dashboard
 * bound to a run-owned provider child; no Memory API call is intercepted.
 */
const VIEWPORTS = [
  { width: 1440, height: 1024 },
  { width: 640, height: 900 },
  { width: 375, height: 812 },
] as const;

type StateName = "ready" | "sensitive-redacted" | "candidate-awaiting" | "conflict"
  | "no-data" | "offline" | "incompatible" | "pending-approval" | "applying" | "complete"
  | "forgotten-removal";

const SEARCH_STATES = new Set<StateName>(["ready", "sensitive-redacted", "no-data",
  "pending-approval", "applying", "complete", "forgotten-removal"]);
const EFFECT_LABEL: Partial<Record<StateName, string>> = {
  "pending-approval": "pending_approval",
  applying: "applying",
  complete: "completed",
};

function targets(): ReadonlyMap<StateName, string> {
  const raw = process.env["TASK32_STATE_URLS"];
  if (raw === undefined) throw new Error("TASK32_STATE_URLS required");
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null) throw new TypeError("state map required");
  const entries = Object.entries(parsed).map(([key, value]) => {
    if (typeof value !== "string") throw new TypeError(`state url required: ${key}`);
    return [asState(key), value] as const;
  });
  return new Map(entries);
}

function asState(value: string): StateName {
  switch (value) {
    case "ready": case "sensitive-redacted": case "candidate-awaiting":
    case "conflict": case "no-data": case "offline": case "incompatible":
    case "pending-approval": case "applying": case "complete": case "forgotten-removal":
      return value;
    default:
      throw new TypeError(`unknown state: ${value}`);
  }
}

async function openMemory(page: Page, base: string, state: StateName): Promise<void> {
  await page.goto(new URL("/memory", base).toString());
  await expect(page.getByRole("heading", { level: 1, name: "Memory" })).toBeVisible();
  if (!SEARCH_STATES.has(state)) return;
  await page.getByLabel("Memory query").fill("evidence");
  await page.getByRole("button", { name: "Search memory" }).click();
  const effect = EFFECT_LABEL[state];
  if (effect !== undefined) await expect(page.getByText(effect, { exact: true })).toBeVisible();
  if (state === "forgotten-removal") {
    await expect(page.getByText("No visible memory records")).toBeVisible();
  }
}

async function assertClean(page: Page, label: string): Promise<void> {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow, `${label} horizontal overflow`).toBe(0);
  const audit = await new AxeBuilder({ page }).analyze();
  const blocking = audit.violations.filter(item => ["serious", "critical"].includes(item.impact ?? ""));
  expect(blocking.map(item => item.id), `${label} axe serious/critical`).toEqual([]);
}

for (const [state, base] of targets()) {
  test(`Memory ${state} state renders cleanly at every accepted viewport`, async ({ page }, testInfo) => {
    for (const viewport of VIEWPORTS) {
      // Given a real built dashboard bound to a run-owned provider
      await page.setViewportSize(viewport);
      // When the owner opens the Memory surface in this state
      await openMemory(page, base, state);
      // Then the surface is overflow-free and free of serious accessibility defects
      const label = `${state}@${String(viewport.width)}`;
      await assertClean(page, label);
      const screenshot = testInfo.outputPath(`${label}.png`);
      await page.screenshot({ path: screenshot, fullPage: true });
      await testInfo.attach(label, { path: screenshot, contentType: "image/png" });
    }
  });
}

test("Memory ready state wraps CJK record text without horizontal overflow", async ({ page }) => {
  // Given the narrowest accepted viewport against the real schema-4 provider
  const base = targets().get("ready");
  if (base === undefined) throw new Error("ready target required");
  await page.setViewportSize({ width: 375, height: 812 });
  // When a record carrying Korean text is searched
  await openMemory(page, base, "ready");
  const cjk = page.locator("strong", { hasText: "기억 표면은" }).first();
  await expect(cjk).toBeVisible();
  // Then the record box wraps rather than extending the document
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBe(0);
  const wrapped = await cjk.evaluate(node => {
    const style = globalThis.getComputedStyle(node);
    return { whiteSpace: style.whiteSpace, wordBreak: style.overflowWrap || style.wordBreak };
  });
  expect(wrapped.whiteSpace).not.toBe("nowrap");
});

test("Memory search is reachable and operable with the keyboard alone", async ({ page }) => {
  // Given the ready Memory surface
  const base = targets().get("ready");
  if (base === undefined) throw new Error("ready target required");
  await page.setViewportSize({ width: 1440, height: 1024 });
  await page.goto(new URL("/memory", base).toString());
  await expect(page.getByRole("heading", { level: 1, name: "Memory" })).toBeVisible();
  // When the owner reaches the query field using only Tab and types a query
  const query = page.getByLabel("Memory query");
  for (let press = 0; press < 40; press += 1) {
    if (await query.evaluate(node => node === document.activeElement)) break;
    await page.keyboard.press("Tab");
  }
  await expect(query).toBeFocused();
  await page.keyboard.type("evidence");
  await page.keyboard.press("Enter");
  // Then results settle without a pointer ever being used
  await expect(page.locator("p.memory-status")).toBeVisible();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBe(0);
});
