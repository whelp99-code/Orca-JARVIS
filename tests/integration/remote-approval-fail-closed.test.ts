import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { request } from "undici";
import { describe, expect, it } from "vitest";
import { ControlPlane } from "../../src/control-plane.js";
import { createDashboardServer } from "../../src/dashboard/server.js";
import { createDashboardSession } from "../../src/dashboard/session.js";
import { initialized, tempDb } from "../helpers.js";
import { createP256Authenticator, signAssertion } from "../fixtures/webauthn-p256.js";
import {
  createRemoteService,
  REMOTE_ORIGIN,
  REMOTE_RP_ID,
  workflowRequest,
} from "../fixtures/remote-approval-support.js";

function staticRoot(): string {
  const root = dirname(tempDb());
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "index.html"), "<!doctype html><title>JARVIS</title>");
  return root;
}

type ClockBox = { current: Date };

async function primed(requestId: string): Promise<{
  db: Awaited<ReturnType<typeof initialized>>;
  server: ReturnType<typeof createDashboardServer>;
  host: string;
  challengeId: string;
  challengeB64: string;
  authenticator: ReturnType<typeof createP256Authenticator>;
  clock: ClockBox;
}> {
  const db = await initialized();
  const clock: ClockBox = { current: new Date() };
  new ControlPlane(db).stage(workflowRequest(requestId, clock.current), clock.current);
  const service = createRemoteService(db);
  const owner = service.ensureOwner(clock.current);
  const authenticator = createP256Authenticator(owner.user_handle);
  service.installActiveCredential({
    credential_id: authenticator.credentialIdB64, public_key_cose: authenticator.coseKey,
    algorithm: -7, sign_count: 0, backup_eligible: 0, backup_state: 0, now: clock.current,
  });
  const session = createDashboardSession();
  const server = createDashboardServer({
    db, staticRoot: staticRoot(), host: "127.0.0.1", port: 0, sessionStore: session,
    remoteApproval: service, clock: () => clock.current,
  });
  const host = `127.0.0.1:${String(server.address.port)}`;
  const optionsRes = await request(`http://${host}/api/v1/remote-approvals/${requestId}/options`, {
    method: "POST",
    headers: { host, origin: REMOTE_ORIGIN, "content-type": "application/json" },
    body: JSON.stringify({ schema_version: 1, decision: "approve" }),
  });
  const optionsBody = await optionsRes.body.json() as { challenge_id: string; options: { challenge: string } };
  return {
    db, server, host, challengeId: optionsBody.challenge_id, challengeB64: optionsBody.options.challenge,
    authenticator, clock,
  };
}

async function verify(host: string, challengeId: string, credential: unknown): Promise<number> {
  const res = await request(`http://${host}/api/v1/remote-approvals/${challengeId}/verify`, {
    method: "POST",
    headers: { host, origin: REMOTE_ORIGIN, "content-type": "application/json" },
    body: JSON.stringify({ schema_version: 1, credential }),
  });
  await res.body.text();
  return res.statusCode;
}

function receipts(db: Awaited<ReturnType<typeof initialized>>): number {
  return (db.db.prepare("SELECT COUNT(*) AS n FROM control_command_receipts").get() as { n: number }).n;
}

function auditRows(db: Awaited<ReturnType<typeof initialized>>, requestId: string): Array<{ outcome: string; uv: number | null; up: number | null }> {
  return db.db.prepare(
    "SELECT outcome, uv, up FROM personal_operation_audit_events WHERE correlation_id=? AND event_type LIKE 'remote.%'",
  ).all(requestId) as Array<{ outcome: string; uv: number | null; up: number | null }>;
}

describe("remote approval fail-closed HTTP crypto", () => {
  it("rejects an assertion bound to the wrong origin and mints no receipt", async () => {
    const ctx = await primed("fail-origin");
    try {
      const credential = signAssertion({
        authenticator: ctx.authenticator, rpId: REMOTE_RP_ID, origin: "https://evil.example.invalid",
        challengeB64: ctx.challengeB64, counter: 1,
      });
      expect(await verify(ctx.host, ctx.challengeId, credential)).toBeGreaterThanOrEqual(400);
      expect(receipts(ctx.db)).toBe(0);
      expect(auditRows(ctx.db, "fail-origin").length).toBeGreaterThan(0);
    } finally {
      ctx.server.close();
      ctx.db.close();
    }
  });

  it("rejects an assertion bound to the wrong RP ID and mints no receipt", async () => {
    const ctx = await primed("fail-rpid");
    try {
      const credential = signAssertion({
        authenticator: ctx.authenticator, rpId: "evil.example.invalid", origin: REMOTE_ORIGIN,
        challengeB64: ctx.challengeB64, counter: 1,
      });
      expect(await verify(ctx.host, ctx.challengeId, credential)).toBeGreaterThanOrEqual(400);
      expect(receipts(ctx.db)).toBe(0);
      expect(auditRows(ctx.db, "fail-rpid").length).toBeGreaterThan(0);
    } finally {
      ctx.server.close();
      ctx.db.close();
    }
  });

  it("rejects an assertion whose user handle is not the singleton principal and mints no receipt", async () => {
    const ctx = await primed("fail-principal");
    try {
      const foreign = createP256Authenticator(Buffer.alloc(32, 9));
      const credential = signAssertion({
        authenticator: { ...ctx.authenticator, userHandle: foreign.userHandle },
        rpId: REMOTE_RP_ID, origin: REMOTE_ORIGIN, challengeB64: ctx.challengeB64, counter: 1,
      });
      expect(await verify(ctx.host, ctx.challengeId, credential)).toBeGreaterThanOrEqual(400);
      expect(receipts(ctx.db)).toBe(0);
      expect(auditRows(ctx.db, "fail-principal").length).toBeGreaterThan(0);
    } finally {
      ctx.server.close();
      ctx.db.close();
    }
  });

  it("rejects a missing-UV assertion and mints no receipt", async () => {
    const ctx = await primed("fail-uv");
    try {
      const credential = signAssertion({
        authenticator: ctx.authenticator, rpId: REMOTE_RP_ID, origin: REMOTE_ORIGIN,
        challengeB64: ctx.challengeB64, counter: 1, flags: 0x01,
      });
      expect(await verify(ctx.host, ctx.challengeId, credential)).toBeGreaterThanOrEqual(400);
      expect(receipts(ctx.db)).toBe(0);
      expect(auditRows(ctx.db, "fail-uv")).toEqual([expect.objectContaining({ uv: 0, up: 1 })]);
    } finally {
      ctx.server.close();
      ctx.db.close();
    }
  });

  it("rejects a verify after challenge expiry and mints no receipt", async () => {
    const ctx = await primed("fail-expiry");
    try {
      ctx.clock.current = new Date(ctx.clock.current.getTime() + 6 * 60_000);
      const credential = signAssertion({
        authenticator: ctx.authenticator, rpId: REMOTE_RP_ID, origin: REMOTE_ORIGIN,
        challengeB64: ctx.challengeB64, counter: 1,
      });
      expect(await verify(ctx.host, ctx.challengeId, credential)).toBe(409);
      expect(receipts(ctx.db)).toBe(0);
      expect(auditRows(ctx.db, "fail-expiry")).toEqual([expect.objectContaining({ outcome: "expired" })]);
      const state = ctx.db.db.prepare("SELECT state FROM webauthn_approval_challenges_v2 WHERE challenge_id=?").get(ctx.challengeId) as { state: string };
      expect(state.state).toBe("expired");
    } finally {
      ctx.server.close();
      ctx.db.close();
    }
  });

  it("rejects a nonincreasing counter and mints no receipt while leaving the credential active", async () => {
    const db = await initialized();
    const now = new Date();
    new ControlPlane(db).stage(workflowRequest("fail-counter", now), now);
    const service = createRemoteService(db);
    const owner = service.ensureOwner(now);
    const authenticator = createP256Authenticator(owner.user_handle);
    service.installActiveCredential({
      credential_id: authenticator.credentialIdB64, public_key_cose: authenticator.coseKey,
      algorithm: -7, sign_count: 5, backup_eligible: 0, backup_state: 0, now,
    });
    const session = createDashboardSession();
    const server = createDashboardServer({
      db, staticRoot: staticRoot(), host: "127.0.0.1", port: 0, sessionStore: session,
      remoteApproval: service, clock: () => now,
    });
    const host = `127.0.0.1:${String(server.address.port)}`;
    try {
      const optionsRes = await request(`http://${host}/api/v1/remote-approvals/fail-counter/options`, {
        method: "POST",
        headers: { host, origin: REMOTE_ORIGIN, "content-type": "application/json" },
        body: JSON.stringify({ schema_version: 1, decision: "approve" }),
      });
      const optionsBody = await optionsRes.body.json() as { challenge_id: string; options: { challenge: string } };
      const credential = signAssertion({
        authenticator, rpId: REMOTE_RP_ID, origin: REMOTE_ORIGIN,
        challengeB64: optionsBody.options.challenge, counter: 4,
      });
      expect(await verify(host, optionsBody.challenge_id, credential)).toBeGreaterThanOrEqual(400);
      expect(receipts(db)).toBe(0);
      expect(auditRows(db, "fail-counter").length).toBeGreaterThan(0);
      const row = db.db.prepare("SELECT sign_count,state FROM webauthn_credentials_v2 WHERE credential_id=?").get(authenticator.credentialIdB64) as { sign_count: number; state: string };
      expect(row).toEqual({ sign_count: 5, state: "active" });
    } finally {
      server.close();
      db.close();
    }
  });
});
