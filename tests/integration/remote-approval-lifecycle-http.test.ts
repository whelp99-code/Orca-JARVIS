import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { request } from "undici";
import { describe, expect, it } from "vitest";
import { ControlPlane, signCommandApproval, type StoredControlCommand } from "../../src/control-plane.js";
import { createDashboardServer } from "../../src/dashboard/server.js";
import { createDashboardSession } from "../../src/dashboard/session.js";
import { initialized, localKey, tempDb } from "../helpers.js";
import { createP256Authenticator, signAttestation } from "../fixtures/webauthn-p256.js";
import { createRemoteService, REMOTE_ORIGIN, REMOTE_RP_ID } from "../fixtures/remote-approval-support.js";

function staticRoot(): string {
  const root = dirname(tempDb());
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "index.html"), "<!doctype html><title>JARVIS</title>");
  return root;
}

function approve(db: Awaited<ReturnType<typeof initialized>>, staged: StoredControlCommand, now: Date) {
  return signCommandApproval({
    schema_version: 1,
    receipt_id: `rcpt-${staged.request_id}`,
    request_id: staged.request_id,
    decision: "approve",
    command_digest: staged.command_digest,
    signer_principal_id: "test-operator",
    authenticated_session_id: `dashboard-session:${staged.request_id}`,
    key_id: "decision-test",
    algorithm: "Ed25519",
    issued_at: now.toISOString(),
    not_before: now.toISOString(),
    expires_at: staged.expires_at,
    nonce: `approval-${staged.request_id}`,
    max_uses: 1,
    status: "issued",
  }, localKey(db));
}

describe("remote approval local lifecycle HTTP", () => {
  it("stages a begin enrollment over local CSRF without activating a credential", async () => {
    const db = await initialized();
    const now = new Date();
    const service = createRemoteService(db);
    const session = createDashboardSession();
    const server = createDashboardServer({
      db, staticRoot: staticRoot(), host: "127.0.0.1", port: 0, sessionStore: session,
      remoteApproval: service, clock: () => now,
    });
    const host = `127.0.0.1:${String(server.address.port)}`;
    const origin = `http://${host}`;
    try {
      const enroll = await request(`http://${host}/api/v1/security/webauthn/enrollments`, {
        method: "POST",
        headers: {
          host, origin, "content-type": "application/json", "x-jarvis-csrf": session.snapshot().csrf_token,
        },
        body: JSON.stringify({ schema_version: 1 }),
      });
      expect(enroll.statusCode).toBe(200);
      const body = await enroll.body.json() as { enrollment_id: string; request_id: string };
      const staged = new ControlPlane(db).list().find(item => item.request_id === body.request_id);
      expect(staged?.action).toBe("remote.credential.enroll.begin");
      expect((db.db.prepare("SELECT COUNT(*) AS n FROM webauthn_credentials_v2 WHERE state='active'").get() as { n: number }).n).toBe(0);
      expect((db.db.prepare("SELECT COUNT(*) AS n FROM control_command_receipts").get() as { n: number }).n).toBe(0);
    } finally {
      server.close();
      db.close();
    }
  });

  it("activates a credential only after two distinct approved ControlPlane receipts", async () => {
    const db = await initialized();
    const now = new Date();
    const service = createRemoteService(db);
    const session = createDashboardSession();
    const server = createDashboardServer({
      db, staticRoot: staticRoot(), host: "127.0.0.1", port: 0, sessionStore: session,
      remoteApproval: service, clock: () => now,
    });
    const host = `127.0.0.1:${String(server.address.port)}`;
    const origin = `http://${host}`;
    const csrf = session.snapshot().csrf_token;
    const control = new ControlPlane(db);
    try {
      const enroll = await request(`http://${host}/api/v1/security/webauthn/enrollments`, {
        method: "POST",
        headers: { host, origin, "content-type": "application/json", "x-jarvis-csrf": csrf },
        body: JSON.stringify({ schema_version: 1 }),
      });
      const began = await enroll.body.json() as { enrollment_id: string; request_id: string };
      const beginRow = control.list().find(item => item.request_id === began.request_id);
      if (beginRow === undefined) throw new Error("begin request");
      const beginDecision = await request(`http://${host}/api/v1/control/requests/${began.request_id}/decision`, {
        method: "POST",
        headers: { host, origin, "content-type": "application/json", "x-jarvis-csrf": csrf },
        body: JSON.stringify({ schema_version: 1, receipt: approve(db, beginRow, now) }),
      });
      expect(beginDecision.statusCode).toBe(200);
      expect((db.db.prepare("SELECT COUNT(*) AS n FROM webauthn_credentials_v2 WHERE state='active'").get() as { n: number }).n).toBe(0);

      const owner = service.store.principal();
      if (owner === undefined) throw new Error("principal");
      const authenticator = createP256Authenticator(owner.user_handle);
      const optionsRes = await request(`http://${host}/api/v1/security/webauthn/registrations/${began.enrollment_id}/options`, {
        method: "POST",
        headers: { host, origin: REMOTE_ORIGIN, "content-type": "application/json" },
        body: JSON.stringify({ schema_version: 1, begin_request_id: began.request_id }),
      });
      expect(optionsRes.statusCode).toBe(200);
      const optionsBody = await optionsRes.body.json() as { ceremony_id: string; options: { challenge: string } };
      const attestation = signAttestation({
        authenticator, rpId: REMOTE_RP_ID, origin: REMOTE_ORIGIN, challengeB64: optionsBody.options.challenge,
      });
      const verifyRes = await request(`http://${host}/api/v1/security/webauthn/registrations/${optionsBody.ceremony_id}/verify`, {
        method: "POST",
        headers: { host, origin: REMOTE_ORIGIN, "content-type": "application/json" },
        body: JSON.stringify({ schema_version: 1, credential: attestation }),
      });
      expect(verifyRes.statusCode).toBe(200);
      const verified = await verifyRes.body.json() as { credential_id: string; activation_request_id: string };
      expect((db.db.prepare("SELECT state FROM webauthn_credentials_v2 WHERE credential_id=?").get(verified.credential_id) as { state: string }).state).toBe("pending");

      const activateRow = control.list().find(item => item.request_id === verified.activation_request_id);
      if (activateRow === undefined) throw new Error("activate request");
      const activate = await request(`http://${host}/api/v1/security/webauthn/credentials/${verified.credential_id}/activate`, {
        method: "POST",
        headers: { host, origin, "content-type": "application/json", "x-jarvis-csrf": csrf },
        body: JSON.stringify({ schema_version: 1, receipt: approve(db, activateRow, now) }),
      });
      expect(activate.statusCode).toBe(200);
      expect((db.db.prepare("SELECT state FROM webauthn_credentials_v2 WHERE credential_id=?").get(verified.credential_id) as { state: string }).state).toBe("active");
      const receiptActions = db.db.prepare(
        `SELECT r.action FROM control_command_requests r JOIN control_command_receipts x ON x.request_id=r.request_id ORDER BY r.action`,
      ).all() as Array<{ action: string }>;
      expect(receiptActions.map(row => row.action)).toEqual([
        "remote.credential.enroll.activate",
        "remote.credential.enroll.begin",
      ]);
    } finally {
      server.close();
      db.close();
    }
  });

  it("rejects principal revoke staging without local CSRF and leaves credentials untouched", async () => {
    const db = await initialized();
    const now = new Date();
    const service = createRemoteService(db);
    const session = createDashboardSession();
    const server = createDashboardServer({
      db, staticRoot: staticRoot(), host: "127.0.0.1", port: 0, sessionStore: session,
      remoteApproval: service, clock: () => now,
    });
    const host = `127.0.0.1:${String(server.address.port)}`;
    try {
      const res = await request(`http://${host}/api/v1/security/remote-principal/revocation-requests`, {
        method: "POST",
        headers: { host, origin: REMOTE_ORIGIN, "content-type": "application/json" },
        body: JSON.stringify({ schema_version: 1, reason: "lost device" }),
      });
      expect(res.statusCode).toBe(403);
      expect((db.db.prepare("SELECT COUNT(*) AS n FROM control_command_receipts").get() as { n: number }).n).toBe(0);
    } finally {
      server.close();
      db.close();
    }
  });
});
