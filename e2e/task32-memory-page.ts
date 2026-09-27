import { AxeBuilder } from "@axe-core/playwright";
import { expect, type Locator, type Page } from "@playwright/test";
import type { MemorySurfaceFixture } from "./task32-memory-fixture.js";

export const CANARY = "TASK32_FIXTURE_SENSITIVE_CANARY";
export const DELETED = "TASK32_FIXTURE_DELETED_SENTINEL";
export const CJK_START = "기억 표면은";
export const VIEWPORTS = [
  { width: 1440, height: 1024 },
  { width: 640, height: 900 },
  { width: 390, height: 844 },
] as const;

/** Drives the built Memory route against one fixture; the page clock is anchored to the fixture clock. */
export class MemoryPageDriver {
  private clocked = false;
  constructor(readonly page: Page, readonly fixture: MemorySurfaceFixture) {}

  status(): Locator { return this.page.locator("p.memory-status"); }
  badge(): Locator { return this.page.locator(".freshness-badge"); }
  detail(): Locator { return this.page.getByRole("region", { name: "Detail" }); }
  lifecycles(): Locator { return this.page.getByRole("list", { name: "Memory effect lifecycles" }); }

  async open(): Promise<void> {
    if (!this.clocked) { this.clocked = true; await this.page.clock.install({ time: await this.fixture.now() }); }
    await this.page.goto(new URL("/memory", this.fixture.app).toString());
    await expect(this.page.getByRole("heading", { level: 1, name: "Memory" })).toBeVisible();
  }
  async search(query = "evidence"): Promise<void> {
    await this.page.getByLabel("Memory query").fill(query);
    await this.page.getByRole("button", { name: "Search memory" }).click();
    await expect(this.page.getByRole("button", { name: "Search memory" })).toBeEnabled();
  }
  async refresh(): Promise<void> {
    await this.page.getByRole("button", { name: "Refresh memory" }).click();
    await expect(this.page.getByRole("button", { name: "Refresh memory" })).toBeEnabled();
  }
  overflow(): Promise<number> {
    return this.page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  }
  async axeClean(label: string): Promise<void> {
    const audit = await new AxeBuilder({ page: this.page }).analyze();
    expect(audit.violations.map(item => `${item.id}: ${item.help}`), `${label} axe`).toEqual([]);
  }
  /** Bodies of every Memory API response from now on; used to prove sentinels never cross the wire. */
  captureResponses(): string[] {
    const bodies: string[] = [];
    this.page.on("response", response => {
      if (!response.url().includes("/api/v1/memory/")) return;
      void response.text().then(text => { bodies.push(text); }, () => undefined);
    });
    return bodies;
  }
  async commandCount(action: string): Promise<number> {
    return (await this.fixture.commands()).filter(row => row.action === action).reduce((sum, row) => sum + row.n, 0);
  }
}
