import { expect, test } from "@playwright/test";
import { productionOrigin } from "../tests/fixtures/dashboard-fixture-ids.js";
import {
  assertAxeClean,
  assertNoHorizontalOverflow,
  attachConsole,
  waitLive,
} from "./browser-qa.js";

const origin = productionOrigin();

test.describe("production smoke", () => {
  test.use({ baseURL: origin });

  test.beforeEach(async ({ request }) => {
    try {
      const health = await request.get(`${origin}/api/v1/health`);
      if (!health.ok()) test.skip();
    } catch {
      test.skip();
    }
  });

  test("read-only overview task agent log and approvals stay live", async ({ page, request }) => {
    const bag = attachConsole(page);
    expect((await request.get(`${origin}/api/v1/health`)).ok()).toBe(true);
    expect((await request.get(`${origin}/api/v1/overview`)).ok()).toBe(true);
    expect((await request.get(`${origin}/api/v1/tasks?limit=20`)).ok()).toBe(true);
    expect((await request.get(`${origin}/api/v1/agents`)).ok()).toBe(true);
    expect((await request.get(`${origin}/api/v1/control/requests`)).ok()).toBe(true);
    await page.goto("/");
    await waitLive(page);
    await expect(page.getByRole("heading", { level: 1, name: "JARVIS Control Center" })).toBeVisible();
    await page.goto("/tasks");
    await expect(page.getByRole("heading", { name: "Tasks" })).toBeVisible();
    await page.goto("/agents");
    await expect(page.getByRole("heading", { name: "Agents" })).toBeVisible();
    const agent = page.getByRole("link", { name: /^sha256:/ });
    if (await agent.count() > 0) {
      await agent.first().click();
      await expect(page.getByRole("heading", { name: "Terminal log" })).toBeVisible();
    }
    await page.goto("/approvals");
    await expect(page.getByRole("heading", { name: "Approvals" })).toBeVisible();
    await assertAxeClean(page);
    await assertNoHorizontalOverflow(page);
    expect(bag.errors).toEqual([]);
  });
});
