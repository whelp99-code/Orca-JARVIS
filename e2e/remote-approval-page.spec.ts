import { expect, test, type Page } from "@playwright/test";
import { attachVirtualAuthenticator, setBadUv } from "./remote-approval-cdp.js";
import { RemoteApprovalFixture } from "./remote-approval-harness.js";
import { createP256Authenticator, signAssertion } from "../tests/fixtures/webauthn-p256.js";
import { REMOTE_ORIGIN, REMOTE_RP_ID } from "../tests/fixtures/remote-approval-support.js";

test.describe.configure({ mode: "serial" });

async function registerOnPage(page: Page, fixture: RemoteApprovalFixture): Promise<void> {
  const began = await fixture.beginEnrollment();
  await fixture.approveLocal(began.request_id);
  await page.getByLabel("Enrollment ID").fill(began.enrollment_id);
  await page.getByLabel("Begin request ID").fill(began.request_id);
  await page.getByRole("button", { name: "Register passkey" }).click();
  await expect(page.locator(".security-status")).toContainText("Passkey registered");
  const pending = fixture.pendingCredential();
  await fixture.activateCredential(pending.credential_id, pending.activation_request_id);
}

async function approveOnPage(page: Page, requestId: string): Promise<void> {
  await page.getByLabel("Request ID", { exact: true }).fill(requestId);
  await page.getByRole("button", { name: "Load" }).click();
  await expect(page.getByText("workflow.start")).toBeVisible();
  await page.getByRole("button", { name: "Approve" }).click();
}

test("enrolls and approves one staged recommendation through the security page", async ({ page }, testInfo) => {
  const fixture = await RemoteApprovalFixture.start();
  try {
    await attachVirtualAuthenticator(page);
    await page.goto(`${fixture.origin}/security`);
    await expect(page.getByRole("heading", { name: "보안" })).toBeVisible();
    await expect(page.locator("[data-enrollment-origin='local']")).toBeVisible();
    await registerOnPage(page, fixture);
    const staged = fixture.stage("page-approve");
    await approveOnPage(page, staged.request_id);
    await expect(page.locator(".security-status")).toContainText("approved");
    expect(fixture.receiptCount(staged.request_id)).toBe(1);
    const claimed = fixture.claim(staged.request_id);
    expect(claimed.receipt_id.length).toBeGreaterThan(0);
    expect(() => fixture.claim(staged.request_id)).toThrow();
    await page.screenshot({ path: testInfo.outputPath("happy-approved.png") });
  } finally {
    await fixture.close();
  }
});

test("rejects a modified argument, replay, expiry, missing UV, and gateway session without a receipt", async ({ page }, testInfo) => {
  const fixture = await RemoteApprovalFixture.start();
  try {
    const authenticator = await attachVirtualAuthenticator(page);
    await page.goto(`${fixture.origin}/security`);
    await registerOnPage(page, fixture);

    const modified = fixture.stage("page-modified");
    await page.route("**/verify", async route => {
      fixture.tamperArgs(modified.request_id);
      await route.continue();
    });
    await approveOnPage(page, modified.request_id);
    await expect(page.locator(".security-alert")).toBeVisible();
    expect(fixture.receiptCount(modified.request_id)).toBe(0);
    expect(fixture.auditCount(modified.request_id)).toBeGreaterThan(0);
    await page.unroute("**/verify");

    const replayed = fixture.stage("page-replay");
    await approveOnPage(page, replayed.request_id);
    await expect(page.locator(".security-status")).toContainText("approved");
    expect(fixture.receiptCount(replayed.request_id)).toBe(1);
    const challenge = fixture.db.db.prepare(
      "SELECT challenge_id FROM webauthn_approval_challenges_v2 WHERE request_id=? AND state='consumed'",
    ).get(replayed.request_id) as { challenge_id: string };
    const replay = await page.evaluate(async input => {
      const response = await fetch(`${input.origin}/api/v1/remote-approvals/${input.challengeId}/verify`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ schema_version: 1, credential: { id: "replay" } }),
      });
      return response.status;
    }, { origin: fixture.origin, challengeId: challenge.challenge_id });
    expect(replay).toBe(409);
    expect(fixture.receiptCount(replayed.request_id)).toBe(1);
    expect(fixture.auditCount(replayed.request_id)).toBeGreaterThan(1);

    const expired = fixture.stage("page-expired");
    await page.getByLabel("Request ID", { exact: true }).fill(expired.request_id);
    await page.getByRole("button", { name: "Load" }).click();
    await page.route("**/verify", async route => {
      fixture.clock.current = new Date(Date.now() + 6 * 60_000);
      fixture.clock.pinned = true;
      await route.continue();
    });
    await page.getByRole("button", { name: "Approve" }).click();
    await expect(page.locator(".security-alert")).toBeVisible();
    expect(fixture.receiptCount(expired.request_id)).toBe(0);
    expect(fixture.auditCount(expired.request_id)).toBeGreaterThan(0);
    const expiredState = fixture.db.db.prepare(
      "SELECT state FROM webauthn_approval_challenges_v2 WHERE request_id=?",
    ).get(expired.request_id) as { state: string };
    expect(expiredState.state).toBe("expired");
    await page.unroute("**/verify");
    fixture.clock.current = new Date(fixture.clock.current.getTime() + 1000);

    await setBadUv(authenticator, true);
    const missingUv = fixture.stage("page-uv");
    await approveOnPage(page, missingUv.request_id);
    await expect(page.locator(".security-alert")).toBeVisible();
    expect(fixture.receiptCount(missingUv.request_id)).toBe(0);
    expect(fixture.auditCount(missingUv.request_id)).toBeGreaterThan(0);
    const uv = fixture.db.db.prepare(
      "SELECT uv FROM personal_operation_audit_events WHERE correlation_id=? AND outcome='rejected'",
    ).get(missingUv.request_id) as { uv: number };
    expect(uv.uv).toBe(0);
    await setBadUv(authenticator, false);
    await page.screenshot({ path: testInfo.outputPath("failures.png") });
  } finally {
    await fixture.close();
  }
});

test("rejects wrong owner, origin, RP, and a revoked passkey with an audit row and zero receipts", async ({ page }) => {
  const fixture = await RemoteApprovalFixture.start();
  try {
    await attachVirtualAuthenticator(page);
    await page.goto(`${fixture.origin}/security`);
    await registerOnPage(page, fixture);
    const owner = fixture.db.db.prepare("SELECT user_handle FROM remote_owner_principals_v2").get() as { user_handle: Buffer };
    const known = createP256Authenticator(owner.user_handle);
    fixture.service.installActiveCredential({
      credential_id: known.credentialIdB64, public_key_cose: known.coseKey, algorithm: -7,
      sign_count: 0, backup_eligible: 0, backup_state: 0, now: fixture.clock.current,
    });
    const cases = [
      { name: "origin", origin: "https://evil.example.invalid", rpId: REMOTE_RP_ID, handle: owner.user_handle },
      { name: "rp", origin: REMOTE_ORIGIN, rpId: "evil.example.invalid", handle: owner.user_handle },
      { name: "owner", origin: REMOTE_ORIGIN, rpId: REMOTE_RP_ID, handle: Buffer.alloc(32, 9) },
    ] as const;
    for (const item of cases) {
      const staged = fixture.stage(`page-${item.name}`);
      const issued = await page.evaluate(async input => {
        const response = await fetch(`${input.origin}/api/v1/remote-approvals/${input.requestId}/options`, {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ schema_version: 1, decision: "approve" }),
        });
        return response.json() as Promise<{ challenge_id: string; options: { challenge: string } }>;
      }, { origin: fixture.origin, requestId: staged.request_id });
      const assertion = signAssertion({
        authenticator: { ...known, userHandle: item.handle },
        rpId: item.rpId,
        origin: item.origin,
        challengeB64: issued.options.challenge,
        counter: 1,
      });
      const status = await page.evaluate(async input => {
        const response = await fetch(`${input.origin}/api/v1/remote-approvals/${input.challengeId}/verify`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ schema_version: 1, credential: input.credential }),
        });
        return response.status;
      }, { origin: fixture.origin, challengeId: issued.challenge_id, credential: assertion });
      expect(status, item.name).toBeGreaterThanOrEqual(400);
      expect(fixture.receiptCount(staged.request_id), item.name).toBe(0);
      expect(fixture.auditCount(staged.request_id), item.name).toBeGreaterThan(0);
    }

    await fixture.revoke(known.credentialIdB64);
    const revoked = fixture.stage("page-revoked");
    const revokedOptions = await page.evaluate(async input => {
      const response = await fetch(`${input.origin}/api/v1/remote-approvals/${input.requestId}/options`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ schema_version: 1, decision: "approve" }),
      });
      return response.json() as Promise<{ challenge_id: string; options: { challenge: string } }>;
    }, { origin: fixture.origin, requestId: revoked.request_id });
    const revokedAssertion = signAssertion({
      authenticator: known, rpId: REMOTE_RP_ID, origin: REMOTE_ORIGIN,
      challengeB64: revokedOptions.options.challenge, counter: 2,
    });
    const revokedStatus = await page.evaluate(async input => {
      const response = await fetch(`${input.origin}/api/v1/remote-approvals/${input.challengeId}/verify`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ schema_version: 1, credential: input.credential }),
      });
      return response.status;
    }, { origin: fixture.origin, challengeId: revokedOptions.challenge_id, credential: revokedAssertion });
    expect(revokedStatus).toBeGreaterThanOrEqual(400);
    expect(fixture.receiptCount(revoked.request_id)).toBe(0);
    expect(fixture.auditCount(revoked.request_id)).toBeGreaterThan(0);
  } finally {
    await fixture.close();
  }
});

test("refuses a gateway session that presents no assertion", async ({ page }) => {
  const fixture = await RemoteApprovalFixture.start();
  try {
    await page.goto(`${fixture.origin}/security`);
    const staged = fixture.stage("page-session");
    const issued = await page.evaluate(async input => {
      const response = await fetch(`${input.origin}/api/v1/remote-approvals/${input.requestId}/options`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ schema_version: 1, decision: "approve" }),
      });
      return response.json() as Promise<{ challenge_id: string }>;
    }, { origin: fixture.origin, requestId: staged.request_id });
    const status = await page.evaluate(async input => {
      const response = await fetch(`${input.origin}/api/v1/remote-approvals/${input.challengeId}/verify`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ schema_version: 1 }),
      });
      return response.status;
    }, { origin: fixture.origin, challengeId: issued.challenge_id });
    expect(status).toBeGreaterThanOrEqual(400);
    expect(fixture.receiptCount(staged.request_id)).toBe(0);
    expect(fixture.auditCount(staged.request_id)).toBeGreaterThan(0);
  } finally {
    await fixture.close();
  }
});
