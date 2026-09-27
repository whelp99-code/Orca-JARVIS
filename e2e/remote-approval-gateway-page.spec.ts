import type { Page } from "@playwright/test";
import { attachVirtualAuthenticator, setBadUv } from "./remote-approval-cdp.js";
import { expect, test } from "./remote-approval-gateway-fixture.js";
import type { ProductionGatewayFixture } from "../tests/fixtures/remote-approval-gateway-harness.js";
import { workflowRequest } from "../tests/fixtures/remote-approval-support.js";

test.describe.configure({ mode: "serial" });

/** Enrollment begins in the local session; the phone page performs the client ceremony. */
async function registerOnGatewayPage(page: Page, gateway: ProductionGatewayFixture): Promise<string> {
  const began = await gateway.beginEnrollment();
  await page.getByLabel("Enrollment ID").fill(began.enrollment_id);
  await page.getByLabel("Begin request ID").fill(began.request_id);
  await page.getByRole("button", { name: "Register passkey" }).click();
  await expect(page.locator(".security-status")).toContainText("Passkey registered");
  const pending = gateway.db.db.prepare(
    "SELECT credential_id, activation_request_id, credential_id_digest FROM webauthn_credentials_v2 WHERE state='pending'",
  ).get() as { credential_id: string; activation_request_id: string; credential_id_digest: string };
  await gateway.activateCredential(pending.credential_id, pending.activation_request_id);
  return pending.credential_id_digest.slice(7, 23);
}

/** The phone shell bootstraps its gateway session cookie before any route renders. */
async function openSecurityPage(page: Page, origin: string): Promise<void> {
  const bootstrapped = await page.goto(`${origin}/api/v1/phone/session`);
  expect(bootstrapped?.status()).toBe(200);
  await page.goto(`${origin}/security`);
}

async function approveOnPage(page: Page, requestId: string): Promise<void> {
  await page.getByLabel("Request ID", { exact: true }).fill(requestId);
  await page.getByRole("button", { name: "Load" }).click();
  await expect(page.getByText("workflow.start")).toBeVisible();
  await page.getByRole("button", { name: "Approve" }).click();
}

test("registers on the phone page and approves one staged request exactly once", async ({
  page, gateway, origin,
}, testInfo) => {
  await attachVirtualAuthenticator(page);
  await openSecurityPage(page, origin);
  await expect(page.getByRole("heading", { name: "보안" })).toBeVisible();
  await expect(page.locator("[data-enrollment-origin='gateway']")).toBeVisible();

  const digestPrefix = await registerOnGatewayPage(page, gateway);

  await page.getByRole("button", { name: "Refresh credentials" }).click();
  await expect(page.locator(".security-status")).toContainText("Listed 1 passkeys");
  await expect(page.getByText(digestPrefix)).toBeVisible();
  const local = await gateway.localGet("/api/v1/security/webauthn/credentials", {
    "x-jarvis-csrf": gateway.session.snapshot().csrf_token,
  });
  expect(local.body.items).toEqual([{ credential_id_prefix: digestPrefix, state: "active" }]);

  const staged = gateway.control.stage(workflowRequest("gateway-page-approve", gateway.now()), gateway.now());
  await approveOnPage(page, staged.request_id);
  await expect(page.locator(".security-status")).toContainText("approved");

  expect(gateway.receiptCount(staged.request_id)).toBe(1);
  const claimed = gateway.control.claim(staged.request_id, "gateway-page-worker", gateway.now());
  expect(claimed.receipt_id.length).toBeGreaterThan(0);
  expect(() => gateway.control.claim(staged.request_id, "gateway-page-worker", gateway.now())).toThrow();
  expect(gateway.auditRows(staged.request_id).map(row => row.outcome)).toEqual(["translated"]);
  await page.screenshot({ path: testInfo.outputPath("gateway-approved.png") });
});

test("refuses an assertion without user verification, minting nothing and auditing once", async ({
  page, gateway, origin,
}, testInfo) => {
  const authenticator = await attachVirtualAuthenticator(page);
  await openSecurityPage(page, origin);
  await registerOnGatewayPage(page, gateway);

  await setBadUv(authenticator, true);
  const staged = gateway.control.stage(workflowRequest("gateway-page-uv", gateway.now()), gateway.now());
  await approveOnPage(page, staged.request_id);
  await expect(page.locator(".security-alert")).toBeVisible();

  expect(gateway.receiptCount(staged.request_id)).toBe(0);
  const rows = gateway.auditRows(staged.request_id);
  expect(rows.map(row => [row.outcome, row.reason_code])).toEqual([["rejected", "crypto"]]);
  expect(rows.map(row => row.uv)).toEqual([0]);
  await page.screenshot({ path: testInfo.outputPath("gateway-uv-refused.png") });
});
