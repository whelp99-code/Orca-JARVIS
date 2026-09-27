import { expect, test } from "@playwright/test";
import { MemorySurfaceFixture, type ProviderMode } from "./task32-memory-fixture.js";
import { CJK_START, DELETED, MemoryPageDriver } from "./task32-memory-page.js";

/**
 * Real-state Memory flows. Every test drives the built dashboard against the in-repo fixture
 * (`tests/fixtures/memory-surface-fixture.ts`); owner approval and provider changes go through the
 * fixture's control port. No Memory API call is intercepted. Layout, CJK, and keyboard coverage
 * lives in `task32-memory-layout.spec.ts`.
 */
let fixture: MemorySurfaceFixture;
test.beforeEach(async () => { fixture = await MemorySurfaceFixture.start(); });
test.afterEach(async () => { await fixture.stop(); });

test("happy path: search, inspect citation, correct, observe superseded, then forget", async ({ page }, testInfo) => {
  test.setTimeout(90_000);
  const memory = new MemoryPageDriver(page, fixture);
  const pageErrors: string[] = [];
  page.on("pageerror", error => { pageErrors.push(error.message); });
  // Given the owner searches and inspects a cited record
  await memory.open();
  await expect(memory.badge()).toHaveText("ready");
  await memory.search();
  await page.getByRole("button", { name: /Project Atlas/ }).click();
  const detail = memory.detail();
  await expect(detail.getByRole("term").filter({ hasText: "Citation" })).toBeVisible();
  await expect(detail.getByText("Memory citation")).toBeVisible();
  await expect(detail.getByText("Memory provider / provider_owned")).toBeVisible();
  await expect(detail.locator("dd[data-history-state]")).toHaveText("current");
  await expect(detail.getByText("No owner commands recorded for this record.")).toBeVisible();
  expect(await page.content()).not.toContain("/vault/");
  await page.screenshot({ path: testInfo.outputPath("01-detail-citation-1440.png"), fullPage: true });
  // When a correction is double-clicked
  await detail.getByLabel("Replacement").fill("Project Atlas weekly review moved to Tuesday");
  await detail.getByRole("button", { name: "Stage correction" }).dblclick();
  // Then exactly one command is staged and the outcome is announced in the live status
  await expect(memory.status()).toHaveText("Pending owner approval");
  expect(await memory.commandCount("memory.outbox.dispatch")).toBe(1);
  await expect(memory.lifecycles().getByText("Correction")).toBeVisible();
  await expect(memory.lifecycles().getByText("Pending owner approval")).toBeVisible();
  // And the record's own history shows the pending attempt
  await page.getByRole("button", { name: /Project Atlas/ }).click();
  await expect(detail.getByRole("list", { name: "Record history" }).getByText("pending owner approval")).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("02-correction-staged-1440.png"), fullPage: true });
  // When the Linux owner approves and the surface is refreshed
  await fixture.approve();
  await memory.refresh();
  await memory.search();
  // Then the old record renders as superseded metadata, never its old text
  const superseded = page.getByRole("button", { name: /Superseded record/ });
  await expect(superseded).toBeVisible();
  await superseded.click();
  await expect(detail.locator("dd[data-history-state]")).toContainText("superseded / superseded by memui:control:v1:");
  await expect(detail.getByText(/Receipt fixture-approve-/)).toBeVisible();
  await expect(detail.getByText("approved and effective")).toBeVisible();
  expect(await detail.getByRole("button").count()).toBe(0);
  expect(await page.content()).not.toContain("happens on Monday");
  await expect(memory.lifecycles().getByText("Approved, applying at provider")).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("03-superseded-1440.png"), fullPage: true });
  // When the provider applies the correction
  await fixture.applyCorrection("Project Atlas weekly review moved to Tuesday");
  await memory.search();
  await expect(page.getByRole("button", { name: /moved to Tuesday/ })).toBeVisible();
  expect(await page.content()).not.toContain("happens on Monday");
  // When the owner forgets the corrected record with a double click
  await page.getByRole("button", { name: /moved to Tuesday/ }).click();
  await detail.getByRole("checkbox").check();
  await detail.getByRole("button", { name: "Stage forgetting" }).dblclick();
  await expect(memory.status()).toHaveText("Pending owner approval");
  expect(await memory.commandCount("memory.delete")).toBe(1);
  await expect(memory.lifecycles().getByText("Forgetting")).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("04-forget-staged-1440.png"), fullPage: true });
  await fixture.approve();
  await memory.refresh();
  await memory.search();
  // Then the forgotten record is gone from the surface while unrelated records remain
  await expect(page.getByRole("button", { name: new RegExp(CJK_START) })).toBeVisible();
  expect(await page.content()).not.toContain("moved to Tuesday");
  expect(await page.content()).not.toContain("happens on Monday");
  await page.screenshot({ path: testInfo.outputPath("05-after-forget-1440.png"), fullPage: true });
  expect(pageErrors).toEqual([]);
  await memory.axeClean("happy path end");
});

test("unauthorized sensitive read stays redacted in the DOM and on the wire", async ({ page }, testInfo) => {
  const memory = new MemoryPageDriver(page, fixture);
  const bodies = memory.captureResponses();
  await memory.open();
  await memory.search();
  const redacted = page.getByRole("button", { name: /\[REDACTED\]/ });
  await expect(redacted).toBeVisible();
  await redacted.click();
  await expect(memory.detail().getByText("Sensitive value remains redacted.")).toBeVisible();
  await expect(memory.detail().getByText("Private citation")).toBeVisible();
  await expect(memory.detail().getByRole("button", { name: "Stage correction" })).toHaveCount(0);
  expect(await page.content()).not.toContain("TASK32_FIXTURE_SENSITIVE_CANARY");
  expect(bodies.join("\n")).not.toContain("TASK32_FIXTURE_SENSITIVE_CANARY");
  await page.screenshot({ path: testInfo.outputPath("06-sensitive-redacted-1440.png"), fullPage: true });
});

test("stale selection is rejected, announced safely, and disarmed without a page error", async ({ page }) => {
  const memory = new MemoryPageDriver(page, fixture);
  const pageErrors: string[] = [];
  page.on("pageerror", error => { pageErrors.push(error.message); });
  // Given a selected record whose privacy epoch moves on out of band
  await memory.open();
  await memory.search();
  await page.getByRole("button", { name: /Project Atlas/ }).click();
  const detail = memory.detail();
  await expect(detail.getByRole("button", { name: "Stage JSON export" })).toBeEnabled();
  const session = await page.request.get(new URL("/api/v1/session", fixture.app).toString());
  const csrf = String(Reflect.get(await session.json(), "csrf_token"));
  const headers = { "X-JARVIS-CSRF": csrf, Origin: fixture.app, "Content-Type": "application/json" };
  const found = await page.request.post(new URL("/api/v1/memory/search", fixture.app).toString(),
    { headers, data: { schema_version: 1, query: "sentinel", limit: 20 } });
  const items = Reflect.get(await found.json(), "items") as Array<{ title: string; record_token: string; record_revision: string }>;
  const sentinel = items.find(item => item.title.includes(DELETED));
  if (sentinel === undefined) throw new Error("sentinel record required");
  const staged = await page.request.post(new URL("/api/v1/memory/records/actions/forget", fixture.app).toString(),
    { headers, data: { schema_version: 1, intent_id: `memui:intent:v1:${"a".repeat(64)}`,
      record_token: sentinel.record_token, record_revision: sentinel.record_revision,
      payload: { acknowledge_irreversible: true, erasure_claim: "managed_erasure" } } });
  expect(staged.status()).toBe(202);
  // The staging is broadcast over SSE; the page reloads under the unchanged epoch and keeps its selection.
  await expect(memory.lifecycles().getByText("Forgetting")).toBeVisible();
  await expect(detail.getByRole("heading", { level: 3 })).toContainText("Project Atlas");
  // The approval is not broadcast to Memory (Linux binds it), so the page still holds epoch-0 tokens.
  await fixture.approve();
  // When the owner acts on the now-stale selection
  await detail.getByRole("button", { name: "Stage JSON export" }).click();
  // Then the rejection is announced with safe copy and the selection is disarmed
  await expect(memory.status()).toHaveText("This record changed since it was loaded. Search again before acting.");
  await expect(detail.getByText("Select a current record.")).toBeVisible();
  expect(await memory.commandCount("memory.export")).toBe(0);
  expect(await page.content()).not.toContain("MEMORY_SELECTION_STALE");
  expect(pageErrors).toEqual([]);
});

test("deleted sentinel never renders after an approved forget", async ({ page }, testInfo) => {
  const memory = new MemoryPageDriver(page, fixture);
  const bodies = memory.captureResponses();
  await memory.open();
  await memory.search();
  await page.getByRole("button", { name: new RegExp(DELETED) }).click();
  await memory.detail().getByRole("checkbox").check();
  await memory.detail().getByRole("button", { name: "Stage forgetting" }).click();
  await expect(memory.status()).toHaveText("Pending owner approval");
  await fixture.approve();
  bodies.length = 0;
  await memory.refresh();
  await memory.search();
  await expect(page.getByRole("button", { name: /Project Atlas/ })).toBeVisible();
  expect(await page.content()).not.toContain(DELETED);
  expect(bodies.join("\n")).not.toContain(DELETED);
  await page.screenshot({ path: testInfo.outputPath("07-deleted-sentinel-absent-1440.png"), fullPage: true });
});

for (const mode of ["offline", "unavailable"] as const satisfies readonly ProviderMode[]) {
  test(`${mode} provider is announced and never presented as empty memory`, async ({ page }, testInfo) => {
    const memory = new MemoryPageDriver(page, fixture);
    const copy = mode === "offline" ? "provider offline" : "provider unavailable";
    await fixture.mode(mode);
    await memory.open();
    await expect(memory.badge()).toHaveText(mode);
    await expect(memory.status()).toContainText(copy);
    await memory.search();
    await expect(page.getByText("No visible memory records")).toHaveCount(0);
    await expect(page.getByRole("region", { name: "Search" }).getByRole("status")).toContainText(copy);
    await expect(page.getByRole("button", { name: "Stage correction" })).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath(`08-${mode}-1440.png`), fullPage: true });
    await memory.axeClean(mode);
  });
}

test("search still works after the page has idled past the 60 s status freshness window", async ({ page }, testInfo) => {
  test.setTimeout(150_000);
  const memory = new MemoryPageDriver(page, fixture);
  const requests: string[] = [];
  page.on("request", request => { if (request.url().includes("/api/v1/memory/")) requests.push(new URL(request.url()).pathname); });
  // Given a page that idles until its status goes stale (time itself is the behavior under test)
  await memory.open();
  await expect(memory.badge()).toHaveText("ready");
  await expect(memory.badge()).toHaveText("stale", { timeout: 75_000 });
  await expect(memory.status()).toContainText("Memory status expired");
  requests.length = 0;
  // When the owner searches
  await memory.search();
  // Then a fresh status was obtained, results rendered, and the panels were not reloaded
  await expect(page.getByRole("button", { name: /Project Atlas/ })).toBeVisible();
  await expect(memory.badge()).toHaveText("ready");
  expect(requests).toEqual(["/api/v1/memory/status", "/api/v1/memory/search"]);
  await page.screenshot({ path: testInfo.outputPath("12-idle-65s-search-1440.png"), fullPage: true });
  // And the explicit refresh control is reachable
  await memory.refresh();
  await expect(memory.badge()).toHaveText("ready");
});
