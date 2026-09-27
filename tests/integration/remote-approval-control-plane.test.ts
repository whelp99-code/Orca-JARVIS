import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tempDb } from "../helpers.js";
import { request } from "undici";
import { afterEach, describe, expect, it } from "vitest";
import { ControlPlane } from "../../src/control-plane.js";
import { createDashboardServer } from "../../src/dashboard/server.js";
import { createDashboardSession } from "../../src/dashboard/session.js";
import { initialized, localKey } from "../helpers.js";
import { createP256Authenticator, signAssertion } from "../fixtures/webauthn-p256.js";
import {
  createRemoteService,
  REMOTE_ORIGIN,
  REMOTE_RP_ID,
  workflowRequest,
} from "../fixtures/remote-approval-support.js";

const tmpRoots: string[] = [];
afterEach(() => { tmpRoots.length = 0; });

function staticRoot(): string {
  const root = dirname(tempDb());
  tmpRoots.push(root);
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "index.html"), "<!doctype html><title>JARVIS</title>");
  return root;
}

describe("remote approval ControlPlane translation", () => {
  it("mints exactly one existing receipt when a UV assertion matches the challenge binding", async () => {
    const db = await initialized();
    const control = new ControlPlane(db);
    const now = new Date();
    const staged = control.stage(workflowRequest("cmd-remote-1", now), now);
    const service = createRemoteService(db);
    service.recover(now);
    const owner = service.ensureOwner(now);
    const authenticator = createP256Authenticator(owner.user_handle);
    service.installActiveCredential({
      credential_id: authenticator.credentialIdB64,
      public_key_cose: authenticator.coseKey,
      algorithm: -7,
      sign_count: 0,
      backup_eligible: 0,
      backup_state: 0,
      now,
    });
    const session = createDashboardSession();
    const server = createDashboardServer({
      db, staticRoot: staticRoot(), host: "127.0.0.1", port: 0, sessionStore: session, remoteApproval: service, clock: () => now,
    });
    const base = `http://127.0.0.1:${String(server.address.port)}`;
    try {
      const optionsRes = await request(`${base}/api/v1/remote-approvals/${staged.request_id}/options`, {
        method: "POST",
        headers: { host: `127.0.0.1:${String(server.address.port)}`, origin: REMOTE_ORIGIN, "content-type": "application/json" },
        body: JSON.stringify({ schema_version: 1, decision: "approve" }),
      });
      expect(optionsRes.statusCode).toBe(200);
      const optionsBody = await optionsRes.body.json() as { challenge_id: string; options: { challenge: string } };
      const assertion = signAssertion({
        authenticator, rpId: REMOTE_RP_ID, origin: REMOTE_ORIGIN,
        challengeB64: optionsBody.options.challenge, counter: 0,
      });
      const verifyRes = await request(`${base}/api/v1/remote-approvals/${optionsBody.challenge_id}/verify`, {
        method: "POST",
        headers: { host: `127.0.0.1:${String(server.address.port)}`, origin: REMOTE_ORIGIN, "content-type": "application/json" },
        body: JSON.stringify({ schema_version: 1, credential: assertion }),
      });
      expect(verifyRes.statusCode).toBe(200);
      const verifyBody = await verifyRes.body.json() as { receipt_id: string; decision: string };
      expect(verifyBody.decision).toBe("approve");
      expect((db.db.prepare("SELECT COUNT(*) AS n FROM control_command_receipts WHERE request_id=?").get(staged.request_id) as { n: number }).n).toBe(1);
      const replay = await request(`${base}/api/v1/remote-approvals/${optionsBody.challenge_id}/verify`, {
        method: "POST",
        headers: { host: `127.0.0.1:${String(server.address.port)}`, origin: REMOTE_ORIGIN, "content-type": "application/json" },
        body: JSON.stringify({ schema_version: 1, credential: assertion }),
      });
      expect(replay.statusCode).toBe(409);
      expect((db.db.prepare("SELECT COUNT(*) AS n FROM control_command_receipts WHERE request_id=?").get(staged.request_id) as { n: number }).n).toBe(1);
      const audits = db.db.prepare("SELECT COUNT(*) AS n FROM personal_operation_audit_events WHERE correlation_id=? AND event_type LIKE 'remote.%'").get(staged.request_id) as { n: number };
      expect(audits.n).toBeGreaterThan(1);
      expect(localKey(db)).toBeTruthy();
    } finally {
      server.close();
      db.close();
    }
  });

  it("does not mint a ControlPlane receipt when only a local session cookie and CSRF are presented", async () => {
    const db = await initialized();
    const control = new ControlPlane(db);
    const now = new Date();
    const staged = control.stage(workflowRequest("cmd-remote-session", now), now);
    const service = createRemoteService(db);
    const session = createDashboardSession();
    const server = createDashboardServer({
      db, staticRoot: staticRoot(), host: "127.0.0.1", port: 0, sessionStore: session, remoteApproval: service, clock: () => now,
    });
    const host = `127.0.0.1:${String(server.address.port)}`;
    const origin = `http://${host}`;
    try {
      const csrf = session.snapshot().csrf_token;
      const verifyRes = await request(`http://${host}/api/v1/remote-approvals/not-a-challenge/verify`, {
        method: "POST",
        headers: {
          host, origin, "content-type": "application/json", "x-jarvis-csrf": csrf,
        },
        body: JSON.stringify({ schema_version: 1, credential: { id: "x" } }),
      });
      expect(verifyRes.statusCode).toBeGreaterThanOrEqual(400);
      expect((db.db.prepare("SELECT COUNT(*) AS n FROM control_command_receipts WHERE request_id=?").get(staged.request_id) as { n: number }).n).toBe(0);
      const optionsRes = await request(`http://${host}/api/v1/remote-approvals/${staged.request_id}/options`, {
        method: "POST",
        headers: { host, origin, "content-type": "application/json", "x-jarvis-csrf": csrf },
        body: JSON.stringify({ schema_version: 1, decision: "approve" }),
      });
      expect(optionsRes.statusCode).toBeGreaterThanOrEqual(400);
      expect((db.db.prepare("SELECT COUNT(*) AS n FROM control_command_receipts").get() as { n: number }).n).toBe(0);
    } finally {
      server.close();
      db.close();
    }
  });
});
