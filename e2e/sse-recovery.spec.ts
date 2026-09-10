import { expect, test } from "@playwright/test";

test("recovers a terminal SSE rejection without reloading the page", async ({ page }) => {
  let eventRequests = 0;
  const unexpectedErrors: string[] = [];
  const mutations: string[] = [];
  page.on("pageerror", error => unexpectedErrors.push(error.message));
  page.on("console", message => {
    if (message.type() !== "error") return;
    // Only the deliberately rejected events response is expected to log an HTTP error.
    if (message.location().url.endsWith("/api/v1/events")
      && /Failed to load resource: the server responded with a status of 503/u.test(message.text())) return;
    unexpectedErrors.push(message.text());
  });
  page.on("request", request => {
    if (!["GET", "HEAD"].includes(request.method())) mutations.push(request.method());
  });
  await page.route("**/api/v1/events", async route => {
    eventRequests += 1;
    if (eventRequests === 1) {
      await route.fulfill({ status: 503, contentType: "application/json",
        headers: { "Retry-After": "5" }, body: JSON.stringify({ error: { code: "SSE_CAPACITY_EXCEEDED" } }) });
    } else await route.continue();
  });
  await page.goto("/overview");
  const live = page.getByRole("status", { name: "실시간", exact: true });
  await expect(live).toHaveText("다시 연결 중");
  expect(eventRequests).toBe(1);
  // The first snapshot on the replacement stream must rehydrate canonical overview data.
  const refreshed = page.waitForResponse(response => response.url().endsWith("/api/v1/overview")
    && response.status() === 200);
  await expect(live).toHaveText("연결됨", { timeout: 12_000 });
  await refreshed;
  expect(eventRequests).toBe(2);
  expect(unexpectedErrors).toEqual([]);
  expect(mutations).toEqual([]);
});
