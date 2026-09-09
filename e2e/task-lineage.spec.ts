import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { once } from "node:events";
import { expect, test } from "@playwright/test";
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
    await page.getByLabel("저장소 최상위 경로").fill(ready.root);
    await page.getByLabel("새 결과 브랜치 이름").fill("browser-lineage");
    await page.getByLabel("파일 경로 1").fill("answer.mjs");
    await page.getByLabel("검사 인수 1").fill("--check\nanswer.mjs");
    await page.getByRole("button", { name: "계획 준비", exact: true }).click();
    const preview = page.getByRole("region", { name: "실행 계획 검토" });
    await expect(preview).toBeVisible();
    await page.getByRole("combobox", { name: "업무 관계" }).selectOption("rework");
    await expect(preview).toHaveCount(0);
    await page.getByRole("button", { name: "계획 준비", exact: true }).click();
    await expect(preview).toHaveCount(0);
    await page.getByLabel("이전 요청 ID").fill(ready.prior_id);
    await page.getByLabel("이전 요청 다이제스트").fill(ready.prior_digest);
    await page.getByRole("button", { name: "계획 준비", exact: true }).click();
    await expect(preview).toContainText("기존 업무 재작업");
    await page.getByLabel("이전 요청 ID").fill("missing-prior");
    await expect(preview).toHaveCount(0);
    await page.getByLabel("이전 요청 ID").fill(ready.prior_id);
    await page.getByRole("button", { name: "계획 준비", exact: true }).click();
    await page.getByRole("button", { name: "검토한 계획 승인 요청" }).click();
    await expect(page.getByLabel("Signed receipt JSON")).toBeVisible();
    await page.reload();
    const pending = page.getByRole("article", { name: /^실행 요청 / }).filter({ has: page.getByLabel("Signed receipt JSON") });
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
