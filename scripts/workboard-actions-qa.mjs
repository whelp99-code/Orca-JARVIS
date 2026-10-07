import assert from "node:assert/strict";
import { readlinkSync, writeFileSync } from "node:fs";
import { chromium } from "@playwright/test";
import { startWorkboardActionDashboard } from "../dist/tests/fixtures/workboard-action-dashboard.js";

const symlink = "/home/jm/.local/state/orca-jarvis/authority/current";
const expected = "releases/ef49ba0dda37eb3b93e1306eba1ea6e8bf7ade9c";
const before = readlinkSync(symlink); assert.equal(before, expected);
const fixture = await startWorkboardActionDashboard();
let browser;
const evidence = { kind: "disposable-ui-and-route-qa", production_before: before, dashboard_origin: fixture.origin,
  source_endpoint: fixture.agent.endpoint, cases: [], journal: [], cleanup: {} };
try {
  browser = await chromium.launch({ channel: "chrome", headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  for (const operation of ["approve", "reject"]) {
    fixture.agent.state.current.requestId = `manual:${operation}`;
    await page.goto(`${fixture.origin}/workboard`);
    const effect = page.locator(`[data-operation="${operation}"]`).first();
    await effect.click();
    const dialog = page.getByRole("dialog");
    await dialog.waitFor({ state: "visible" });
    const confirmationText = await dialog.textContent();
    await dialog.screenshot({ path: `.omo/evidence/workboard/actions-${operation}-dialog.png` });
    const prepared = fixture.actions.journal.db.prepare("SELECT value FROM workboard_action_prepared ORDER BY rowid DESC LIMIT 1").get();
    const token = JSON.parse(prepared.value).token;
    const responseSignal = page.waitForResponse(response => response.url().endsWith("/workboard/actions/submit") && response.request().method() === "POST");
    // Two same-event clicks; the UI guard and durable server guard must both hold.
    await dialog.locator('[data-action="confirm"]').evaluate(button => {
      if (!(button instanceof HTMLButtonElement)) throw new Error("CONFIRM_BUTTON_REQUIRED");
      button.click(); button.click();
    });
    const response = await responseSignal;
    assert.equal(response.status(), 200);
    const result = await response.json(); assert.equal(result.status, "settled"); assert.equal(result.receipt.operation, operation);
    await dialog.waitFor({ state: "detached" });
    const again = await fixture.post("submit", { token, operation });
    assert.equal(again.status, 200); assert.deepEqual(again.body, result);
    assert.equal(fixture.agent.state.sends.filter(send => send.operation === operation).length, 1);
    evidence.cases.push({ operation, confirmationText, result, repeated_click: again, sends: 1 });
    await page.screenshot({ path: `.omo/evidence/workboard/actions-${operation}.png`, fullPage: true });
  }
  evidence.journal = fixture.actions.journal.all();
  assert.equal(evidence.journal.length, 2);
  assert.deepEqual(evidence.journal.map(intent => intent.receipt.operation), ["approve", "reject"]);
  assert.equal(fixture.agent.state.receipts.size, 2);
  evidence.source_receipts = [...fixture.agent.state.receipts.values()];
  evidence.production_after = readlinkSync(symlink); assert.equal(evidence.production_after, expected);
} finally {
  if (browser) await browser.close();
  await fixture.close();
  evidence.cleanup = { browser_closed: true, dashboard_closed: true, fixture_agent_closed: true, disposable_db_removed: true };
}
writeFileSync(".omo/evidence/workboard/actions-manual-qa.json", JSON.stringify(evidence, null, 2) + "\n");
console.log(JSON.stringify({ result: "PASS", cases: evidence.cases.length, journal_receipts: evidence.journal.length,
  production: evidence.production_after, cleanup: evidence.cleanup }));
