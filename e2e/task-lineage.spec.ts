import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { once } from "node:events";
import { expect, test, type Page } from "@playwright/test";
import { attachConsole, assertNoHorizontalOverflow } from "./browser-qa.js";

test("work relationship edits invalidate preview and persist for approval after reload", async ({ page }) => {
  const child = spawn(process.execPath, ["dist/tests/fixtures/task-lineage-browser-server.js"],
    { stdio: ["pipe", "pipe", "pipe"] });
  let stderr = ""; child.stderr.on("data", chunk => { stderr += String(chunk); });
  const lines = createInterface({ input: child.stdout });
  const exited = once(child, "exit");
  const consoleBag = attachConsole(page);
  try {
    const ready = await Promise.race([
      once(lines, "line").then(([line]) => JSON.parse(String(line)) as {
        url: string; root: string; prior_id: string; prior_digest: string;
      }),
      exited.then(() => { throw new Error(`fixture exited before ready: ${stderr}`); }),
    ]);
    await page.goto(`${ready.url}/tasks/task`);
    await expect(page.getByRole("status", { name: "실시간" })).toHaveText("연결됨");
    const root = page.getByLabel("저장소 최상위 경로");
    const branch = page.getByLabel("새 결과 브랜치 이름");
    const file = page.getByLabel("파일 경로 1");
    const args = page.getByLabel("검사 인수 1");
    const prepareButton = page.getByRole("button", { name: "계획 준비", exact: true });
    await expect(root).toBeEditable();
    await root.fill(ready.root);
    await branch.fill("browser-lineage");
    await file.fill("answer.mjs");
    await args.fill("--check\nanswer.mjs");
    await expect(root).toHaveValue(ready.root);
    await expect(branch).toHaveValue("browser-lineage");
    await expect(file).toHaveValue("answer.mjs");
    await expect(prepareButton).toBeEnabled();
    const preview = page.getByRole("region", { name: "실행 계획 검토" });
    await preparePlan(page);
    await expect(preview).toBeVisible();
    await page.getByRole("combobox", { name: "업무 관계" }).selectOption("rework");
    await expect(preview).toHaveCount(0);
    await expect(prepareButton).toBeEnabled();
    await prepareButton.click();
    await expect(preview).toHaveCount(0);
    await page.getByLabel("이전 요청 ID").fill(ready.prior_id);
    await page.getByLabel("이전 요청 다이제스트").fill(ready.prior_digest);
    await expect(page.getByLabel("이전 요청 ID")).toHaveValue(ready.prior_id);
    await expect(page.getByLabel("이전 요청 다이제스트")).toHaveValue(ready.prior_digest);
    await preparePlan(page);
    await expect(preview).toContainText("기존 업무 재작업");
    await page.getByLabel("이전 요청 ID").fill("missing-prior");
    await expect(preview).toHaveCount(0);
    await page.getByLabel("이전 요청 ID").fill(ready.prior_id);
    await expect(page.getByLabel("이전 요청 ID")).toHaveValue(ready.prior_id);
    await preparePlan(page);
    const staged = page.waitForResponse((response) => (
      response.request().method() === "POST" && response.url().endsWith("/execution/stage")
    ));
    await page.getByRole("button", { name: "검토한 계획 승인 요청" }).click();
    expect((await staged).status()).toBe(202);
    await expect(page.getByLabel("서명 영수증")).toBeVisible();
    await page.reload();
    const pending = page.getByRole("article", { name: /^실행 요청 / }).filter({ has: page.getByLabel("서명 영수증") });
    await expect(pending).toContainText("기존 업무 재작업");
    await expect(pending).toContainText(ready.prior_id);
    await expect(pending).toContainText(ready.prior_digest);
    await expect(page.getByRole("button", { name: "Execute approved request" })).toHaveCount(0);
    await assertNoHorizontalOverflow(page);
    expect(consoleBag.errors).toEqual([]);
  } finally {
    lines.close(); child.stdin.end();
    await exited;
  }
});

async function preparePlan(page: Page): Promise<void> {
  const prepared = page.waitForResponse((response) => (
    response.request().method() === "POST" && response.url().endsWith("/execution/prepare")
  ));
  await page.getByRole("button", { name: "계획 준비", exact: true }).click();
  expect((await prepared).ok()).toBe(true);
}
