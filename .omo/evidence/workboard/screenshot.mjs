// Screenshots /workboard with local Chrome at 1440 and 390 and records what is visible.
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { chromium } from "playwright";

const base = process.argv[2];
if (!base) throw new Error("usage: node screenshot.mjs http://127.0.0.1:PORT");
const outDir = resolve(".omo/evidence/workboard");
const browser = await chromium.launch({ channel: "chrome", headless: true });
const observations = { url: `${base}/workboard`, captured_at: new Date().toISOString(), viewports: {} };

for (const [name, viewport] of [["1440", { width: 1440, height: 1000 }], ["390", { width: 390, height: 844 }]]) {
  const context = await browser.newContext({ viewport, deviceScaleFactor: 1, locale: "ko-KR" });
  const page = await context.newPage();
  const consoleErrors = [];
  page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
  page.on("pageerror", (error) => consoleErrors.push(String(error)));
  await page.goto(`${base}/workboard`, { waitUntil: "networkidle" });
  const lead = page.getByRole("region", { name: "지금 당신이 필요한 일" });
  await lead.waitFor({ state: "visible", timeout: 15_000 });
  await page.screenshot({ path: resolve(outDir, `ui-${name}.png`), fullPage: true });
  const summary = await page.evaluate((width) => {
    const card = document.querySelector(".workboard-lead-list .wb-card");
    const visible = (selector) => {
      const element = card?.querySelector(selector);
      if (!element) return false;
      const box = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return box.width > 0 && box.height > 0 && style.visibility !== "hidden" && style.display !== "none";
    };
    const fontSize = (selector) => {
      const element = card?.querySelector(selector);
      return element ? parseFloat(getComputedStyle(element).fontSize) : null;
    };
    const textOverflow = [...document.querySelectorAll(".wb-card *, .workboard-group-head *, .workboard-heading *")]
      .filter((element) => element.scrollWidth > element.clientWidth + 1 && getComputedStyle(element).overflowX !== "visible")
      .map((element) => `${element.tagName.toLowerCase()}.${element.className}`);
    const cardRects = [...document.querySelectorAll(".wb-card")].map((element) => element.getBoundingClientRect());
    const html = document.body.innerHTML;
    return {
      why: visible(".wb-why"),
      what: visible(".wb-what"),
      where: visible(".wb-fact:nth-of-type(1) dd"),
      who: visible(".wb-fact:nth-of-type(2) dd"),
      how: visible(".wb-fact:nth-of-type(3) dd"),
      action: visible(".wb-action-title"),
      action_routes_to_source: card?.querySelector(".wb-source-chip")?.textContent?.includes("원천에서 처리") ?? false,
      evidence_closed_by_default: card?.querySelector(".wb-evidence-toggle")?.getAttribute("aria-expanded") === "false",
      why_is_largest_line: fontSize(".wb-why") > fontSize(".wb-what") && fontSize(".wb-why") > fontSize(".wb-fact dd"),
      font_sizes_px: { why: fontSize(".wb-why"), what: fontSize(".wb-what"), fact: fontSize(".wb-fact dd"), action: fontSize(".wb-action-title") },
      unknown_purpose_text_present: html.includes("목적 확인 필요"),
      default_html_has_sha256: /sha256:/u.test(html),
      default_html_has_term_: /term_/u.test(html),
      default_html_has_pid: /\bPID\b/u.test(html),
      horizontal_page_overflow: document.documentElement.scrollWidth > width,
      cards_exceed_viewport: cardRects.some((rect) => rect.right > width + 1 || rect.left < -1),
      text_overflow_elements: textOverflow,
      card_count: cardRects.length,
      lead_card_count: document.querySelectorAll(".workboard-lead-list .wb-card").length,
      group_count: document.querySelectorAll(".workboard-group").length,
      document_height: document.documentElement.scrollHeight,
    };
  }, viewport.width);
  observations.viewports[name] = { viewport, ...summary, text_overflows: summary.horizontal_page_overflow || summary.cards_exceed_viewport || summary.text_overflow_elements.length > 0, console_errors: consoleErrors };
  await context.close();
}
await browser.close();
writeFileSync(resolve(outDir, "ui-observations.json"), `${JSON.stringify(observations, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(observations, null, 2)}\n`);
