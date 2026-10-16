import { expect, test } from "@playwright/test";
const viewports = [{ width: 1440, height: 1000 }, { width: 390, height: 844 }] as const;

async function maskSensitiveText(page: import("@playwright/test").Page): Promise<void> {
  await page.evaluate(() => {
    const mask = (node: Node) => {
      if (node.nodeType === Node.TEXT_NODE) {
        const text = node.textContent ?? "";
        const masked = text
          .replace(/\bcompany_[a-f0-9]+\b/gi, "company_***")
          .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "workspace-***")
          .replace(/₩[\d,]+/g, "₩***")
          .replace(/\b\d{4}\/\d{1,2}\/\d{1,2}\([^)]+\)(?:\s+\d{2}:\d{2}:\d{2})?/g, "****/**/**(요)");
        if (masked !== text) node.textContent = masked;
        return;
      }
      node.childNodes.forEach(mask);
    };
    mask(document.body);
  });
}

test.describe.configure({ mode: "serial" });

test("finance-read cards render readable summaries at 1440 and 390", async ({ page, baseURL }, testInfo) => {
  test.setTimeout(120_000);
  const app = requiredBase(baseURL);
  for (const viewport of viewports) {
    await page.setViewportSize(viewport);
    await page.goto(new URL("/finance-read", app).toString());
    await expect(page.getByRole("heading", { name: "메일에서 온 후보" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "원본부터 재무 확인까지" })).toBeVisible();
    await maskSensitiveText(page);
    const screenshot = testInfo.outputPath(`finance-readable-${String(viewport.width)}.png`);
    await page.screenshot({ path: screenshot, fullPage: true });
    await testInfo.attach(`finance-readable-${String(viewport.width)}`, {
      path: screenshot,
      contentType: "image/png",
    });
  }
});

function requiredBase(baseURL: string | undefined): string {
  if (baseURL === undefined) throw new Error("baseURL required");
  return baseURL;
}

