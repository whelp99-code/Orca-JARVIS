import { expect, type Page, type TestInfo } from "@playwright/test";
import {
  FIXTURE_SECRET,
  IDS,
  KOREAN_OBJECTIVE,
  REDACTED,
  emptyOrigin,
} from "../tests/fixtures/dashboard-fixture-ids.js";
import {
  assertAxeClean,
  assertNoClip,
  assertNoHorizontalOverflow,
  capture,
  waitLive,
} from "./browser-qa.js";
import { fingerprintFor, signedReceiptFor } from "./fixture-access.js";

export async function overviewFlow(page: Page, testInfo: TestInfo): Promise<void> {
  await page.goto("/overview");
  await waitLive(page);
  await expect(page.getByRole("heading", { level: 1, name: "JARVIS 현황판" })).toBeVisible();
  await expect(page.getByRole("heading", { level: 2, name: "지금 하는 일" })).toBeVisible();
  await expect(page.getByRole("heading", { level: 2, name: "승인 대기" })).toBeVisible();
  await expect(page.getByRole("article", { name: "위험" })).toBeVisible();
  await expect(page.getByRole("heading", { level: 3, name: "최근 일" })).toBeVisible();
  await expect(page.getByRole("heading", { level: 3, name: "승인 대기" })).toBeVisible();
  await expect(page.getByText("service.heartbeat_age_ms")).toBeVisible();
  await expect(page.getByText("workflow.start").first()).toBeVisible();
  await capture(page, testInfo, "overview");
  await assertNoHorizontalOverflow(page);
}

export async function koreanObjectiveFlow(page: Page, testInfo: TestInfo): Promise<void> {
  await page.goto("/proposals");
  await waitLive(page);
  await page.getByLabel("Objective").fill(KOREAN_OBJECTIVE);
  await page.getByLabel("Work type").selectOption("research");
  await page.getByLabel("Completion evidence").fill("visible korean text");
  await page.getByRole("button", { name: "Preview" }).click();
  await expect(page.getByRole("status", { name: "Proposal status" })).toHaveText("Ready");
  await assertNoClip(page, KOREAN_OBJECTIVE);
  await capture(page, testInfo, "korean-objective");
  await assertNoHorizontalOverflow(page);
}

export async function taskGraphFlow(page: Page, testInfo: TestInfo): Promise<void> {
  await page.goto("/tasks");
  await waitLive(page);
  await page.getByRole("link", { name: "agentops-default" }).first().click();
  await expect(page.getByRole("heading", { level: 2, name: "Timeline" })).toBeVisible();
  await expect(page.getByRole("heading", { level: 2, name: "Graph" })).toBeVisible();
  await page.getByRole("button", { name: "List view" }).click();
  await expect(page.getByRole("button", { name: "List view" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("list", { name: "Task sources" })).toBeVisible();
  await page.getByRole("button", { name: "Graph view" }).click();
  await expect(page.getByRole("img", { name: "Task source graph" })).toBeVisible();
  await capture(page, testInfo, "task-graph");
  await assertNoHorizontalOverflow(page);
}

export async function agentLogsFlow(page: Page, testInfo: TestInfo): Promise<void> {
  await page.goto("/agents");
  await waitLive(page);
  await page.getByRole("link", { name: /^sha256:/ }).click();
  await expect(page.getByRole("heading", { name: "Terminal log" })).toBeVisible();
  await expect(page.getByRole("log", { name: "Terminal output" })).toContainText(REDACTED);
  await expect(page.getByRole("log", { name: "Terminal output" })).not.toContainText(FIXTURE_SECRET);
  await capture(page, testInfo, "agent-logs");
  await assertNoHorizontalOverflow(page);
}

export async function emptyDbFlow(page: Page, testInfo: TestInfo): Promise<void> {
  await page.goto(`${emptyOrigin()}/overview`);
  await waitLive(page);
  await expect(page.getByText("최근 기록이 없습니다")).toBeVisible();
  await expect(page.getByText("대기 중인 승인이 없습니다")).toBeVisible();
  await expect(page.getByText("열린 위험이 없습니다")).toBeVisible();
  await expect(page.getByText("연결된 에이전트가 없습니다")).toBeVisible();
  await capture(page, testInfo, "empty");
  await assertNoHorizontalOverflow(page);
}

export async function proposalStageFlow(page: Page, testInfo: TestInfo, baseURL: string): Promise<void> {
  await page.goto("/proposals");
  await waitLive(page);
  const before = fingerprintFor(baseURL);
  await page.getByLabel("Objective").fill("Ship a bounded e2e proposal");
  await page.getByLabel("Work type").selectOption("development");
  await page.getByLabel("Completion evidence").fill("passing playwright suite");
  await page.getByLabel("Constraints").fill("no deployment");
  await page.getByRole("button", { name: "Preview" }).click();
  await expect(page.getByRole("status", { name: "Proposal status" })).toHaveText("Ready");
  expect(fingerprintFor(baseURL)).toBe(before);
  const requirements = page.getByRole("region", { name: "Work requirements" });
  await expect(requirements.getByText("no deployment", { exact: true })).toBeVisible();
  await expect(requirements.getByText("passing playwright suite", { exact: true })).toBeVisible();
  await assertAxeClean(page);
  await assertNoHorizontalOverflow(page);
  await page.getByRole("button", { name: "Stage task" }).click();
  await expect(page.getByRole("heading", { name: "Pending request" })).toBeVisible();
  await expect(page.getByText("workflow.start")).toBeVisible();
  await capture(page, testInfo, "proposal-stage");
}

async function openApprovalTools(page: Page): Promise<void> {
  const tools = page.locator("details.admin-tools");
  if (await tools.count() === 0) return;
  if (await tools.getAttribute("open") === null) await tools.locator("summary").click();
}

export async function invalidReceiptFlow(page: Page, testInfo: TestInfo, baseURL: string): Promise<void> {
  const before = fingerprintFor(baseURL);
  const cardFor = async (): Promise<ReturnType<Page["locator"]>> => {
    await page.goto("/approvals");
    await waitLive(page);
    await openApprovalTools(page);
    return page.locator("article.authority-controls").filter({ hasText: IDS.pendingInvalid });
  };
  const malformed = await cardFor();
  await malformed.getByLabel("서명 영수증").fill("{");
  await malformed.getByRole("button", { name: "서명 제출" }).click();
  await expect(malformed.getByRole("alert")).toHaveText("서명 영수증은 올바른 JSON이어야 합니다");
  expect(fingerprintFor(baseURL)).toBe(before);
  const untrusted = await cardFor();
  await untrusted.getByLabel("서명 영수증").fill(signedReceiptFor(baseURL, IDS.pendingInvalid, "approve", true));
  await untrusted.getByRole("button", { name: "서명 제출" }).click();
  await expect(untrusted.getByRole("alert")).toHaveText("Unable to submit signed receipt");
  expect(fingerprintFor(baseURL)).toBe(before);
  await capture(page, testInfo, "invalid-receipt");
}

export async function approveExecuteFlow(page: Page, baseURL: string): Promise<void> {
  await page.goto("/approvals");
  await waitLive(page);
  await openApprovalTools(page);
  const card = page.locator("article.authority-controls").filter({ hasText: IDS.pendingApprove });
  await card.getByLabel("서명 영수증").fill(signedReceiptFor(baseURL, IDS.pendingApprove, "approve"));
  await card.getByRole("button", { name: "서명 제출" }).click();
  await expect(card.getByText("승인됨", { exact: true })).toBeVisible();
  const executed = page.waitForResponse(response => response.request().method() === "POST"
    && response.url().endsWith(`/api/v1/control/requests/${IDS.pendingApprove}/execute`));
  await card.getByRole("button", { name: "승인된 요청 실행" }).click();
  const response = await executed;
  expect(response.status()).toBe(200);
  expect(await response.json()).toMatchObject({ execution: { request_id: IDS.pendingApprove, state: "completed" } });
  await expect(card).toHaveCount(0);
}

export async function rejectFlow(page: Page, baseURL: string): Promise<void> {
  await page.goto("/approvals");
  await waitLive(page);
  await openApprovalTools(page);
  const card = page.locator("article.authority-controls").filter({ hasText: IDS.pendingReject });
  await card.getByLabel("서명 영수증").fill(signedReceiptFor(baseURL, IDS.pendingReject, "reject"));
  const rejected = page.waitForResponse(response => response.request().method() === "POST"
    && response.url().endsWith(`/api/v1/control/requests/${IDS.pendingReject}/decision`));
  await card.getByRole("button", { name: "서명 제출" }).click();
  const response = await rejected;
  expect(response.status()).toBe(200);
  expect(await response.json()).toMatchObject({ request_id: IDS.pendingReject, state: "rejected" });
  await expect(card).toHaveCount(0);
}

export async function cancelFlow(page: Page): Promise<void> {
  await page.goto(`/tasks/${encodeURIComponent(IDS.cancelTask)}`);
  await waitLive(page);
  const posted = page.waitForResponse((response) => (
    response.request().method() === "POST"
    && response.url().includes(`/api/v1/tasks/${encodeURIComponent(IDS.cancelTask)}/cancel`)
  ));
  await page.getByLabel("Cancellation reason").fill("operator cancelled pending-only task");
  await page.getByRole("button", { name: "Stage cancellation" }).click();
  expect((await posted).status()).toBe(202);
  await expect(page.getByText("workflow.cancel").first()).toBeVisible();
  await page.goto("/approvals");
  await waitLive(page);
  await openApprovalTools(page);
  const card = page.locator("article.authority-controls").filter({ hasText: "workflow.cancel" });
  await expect(card.getByText("대기", { exact: true })).toBeVisible();
}

export async function retryFlow(page: Page): Promise<void> {
  await page.goto("/approvals");
  await waitLive(page);
  await openApprovalTools(page);
  const card = page.locator("article.authority-controls").filter({ hasText: IDS.failedRetry });
  await card.getByRole("button", { name: "실패한 요청 다시 시도" }).click();
  await expect(card.getByRole("heading", { name: "Pending request" })).toBeVisible();
  await expect(card.locator("[aria-label='Pending request']").getByText("대기", { exact: true })).toBeVisible();
}

export async function qualityFlow(page: Page, errors: readonly string[]): Promise<void> {
  await page.goto("/overview");
  await waitLive(page);
  await assertAxeClean(page);
  await assertNoHorizontalOverflow(page);
  expect(errors).toEqual([]);
}
