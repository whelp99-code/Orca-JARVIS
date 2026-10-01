import { rmSync } from "node:fs";
import { resolve } from "node:path";
import { expect, type Page, type TestInfo } from "@playwright/test";
import { createDashboardServer } from "../src/dashboard/server.js";
import { createFixtureEnv } from "../tests/fixtures/dashboard-fixture-env.js";
import { seedRichOverview } from "../tests/fixtures/dashboard-fixture-seed.js";
import { IDS } from "../tests/fixtures/dashboard-fixture-ids.js";
import { assertAxeClean, assertNoHorizontalOverflow, attachConsole, capture, waitLive } from "./browser-qa.js";

export async function expiredRetryFlow(page: Page, testInfo: TestInfo): Promise<void> {
  const env = await createFixtureEnv(resolve("dist/dashboard"));
  const now = new Date();
  await seedRichOverview(env, new Date(now.getTime() - 13 * 60 * 60_000));
  const server = createDashboardServer({ db: env.db, staticRoot: env.staticRoot,
    host: "127.0.0.1", port: 0, clock: () => now });
  const origin = `http://127.0.0.1:${server.address.port}`;
  const consoleBag = attachConsole(page);
  const changes = () => env.db.db.prepare("SELECT total_changes() AS n").get();
  const before = changes();
  try {
    await page.goto(`${origin}/approvals`);
    await waitLive(page);
    const tools = page.locator("details.admin-tools");
    if (await tools.count() > 0 && await tools.getAttribute("open") === null) await tools.locator("summary").click();
    const control = page.locator("article.authority-controls").filter({ hasText: IDS.failedRetry });
    await expect(control.getByRole("button", { name: "Retry failed request" })).toHaveCount(0);
    await expect(control.getByRole("status")).toContainText("새 승인을 받아주세요");
    await assertAxeClean(page);
    await assertNoHorizontalOverflow(page);
    await capture(page, testInfo, "retry-replan-required");
    await control.getByRole("link", { name: "새 작업 제안" }).click();
    await expect(page).toHaveURL(`${origin}/proposals`);
    await expect(page.getByRole("heading", { name: "새 제안" })).toBeVisible();
    expect(changes()).toEqual(before);

    const session = await page.request.get(`${origin}/api/v1/session`);
    const { csrf_token } = await session.json() as { csrf_token: string };
    const retry = await page.request.post(`${origin}/api/v1/control/requests/${IDS.failedRetry}/retry`, {
      headers: { origin, "X-JARVIS-CSRF": csrf_token },
      data: { schema_version: 1, request_id: "expired-retry", nonce: "expired-retry-nonce" },
    });
    expect(retry.status()).toBe(409);
    expect(await retry.json()).toMatchObject({ error: { code: "RETRY_REPLAN_REQUIRED" } });
    expect(changes()).toEqual(before);
    expect(consoleBag.errors).toEqual([]);
  } finally {
    await page.close(); server.close(); env.db.close();
    rmSync(env.tempRoot, { recursive: true, force: true });
  }
}
