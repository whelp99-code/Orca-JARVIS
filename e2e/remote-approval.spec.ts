import { expect, test } from "@playwright/test";
import {
  addVirtualAuthenticator, attachVirtualAuthenticator, getResidentAssertion,
  setAutomaticPresence, setBogusSignature,
} from "./remote-approval-cdp.js";
import { RemoteApprovalFixture } from "./remote-approval-harness.js";

test.describe.configure({ mode: "serial" });

test("loads the built dashboard over fixture TLS after enabling a CDP virtual authenticator", async ({ page }) => {
  const fixture = await RemoteApprovalFixture.start();
  try {
    expect(fixture.tlsPort).toBeGreaterThanOrEqual(1024);
    await attachVirtualAuthenticator(page);
    await page.goto(`${fixture.origin}/security`);
    await expect(page.getByRole("heading", { name: "보안" })).toBeVisible();
    expect(test.info().project.name).toBe("remote-chromium");
  } finally {
    await fixture.close();
  }
});

test("registers two resident passkeys and mints one ControlPlane receipt from the second", async ({ page }) => {
  const fixture = await RemoteApprovalFixture.start();
  try {
    const firstAuth = await attachVirtualAuthenticator(page);
    await page.goto(`${fixture.origin}/security`);
    const first = await fixture.enrollResident(page);
    await setAutomaticPresence(firstAuth, false);
    await addVirtualAuthenticator(firstAuth.cdp, "usb");
    const second = await fixture.enrollResident(page);
    expect(second).not.toBe(first);
    const staged = fixture.stageWorkflow("cdp-second");
    const issued = await fixture.issueOptions(page, staged.request_id, "approve");
    const assertion = await getResidentAssertion(page, issued.options, second);
    const verified = await fixture.verifyAssertion(page, issued.challenge_id, assertion);
    expect(verified.http_status).toBe(200);
    expect(verified.decision).toBe("approve");
    expect(fixture.receiptCount(staged.request_id)).toBe(1);
    const claimed = fixture.claim(staged.request_id);
    expect(claimed.receipt_id).toBe(verified.receipt_id);
  } finally {
    await fixture.close();
  }
});

test("rejects a bogus CDP signature then refuses the reserved challenge without a receipt", async ({ page }) => {
  const fixture = await RemoteApprovalFixture.start();
  try {
    const authenticator = await attachVirtualAuthenticator(page);
    await page.goto(`${fixture.origin}/security`);
    await fixture.enrollResident(page);
    const staged = fixture.stageWorkflow("cdp-bogus");
    const issued = await fixture.issueOptions(page, staged.request_id, "approve");
    await setBogusSignature(authenticator, true);
    const bogus = await getResidentAssertion(page, issued.options);
    const rejected = await fixture.verifyAssertion(page, issued.challenge_id, bogus);
    expect(rejected.http_status).toBe(403);
    expect(fixture.receiptCount(staged.request_id)).toBe(0);
    await setBogusSignature(authenticator, false);
    const retry = await getResidentAssertion(page, issued.options);
    const reserved = await fixture.verifyAssertion(page, issued.challenge_id, retry);
    expect(reserved.http_status).toBe(409);
    expect(fixture.receiptCount(staged.request_id)).toBe(0);
  } finally {
    await fixture.close();
  }
});
