import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { request } from "undici";
import { describe, expect, it } from "vitest";
import { startDashboardCli } from "../../src/dashboard/main.js";
import { createDashboardServer } from "../../src/dashboard/server.js";
import { createDashboardSession } from "../../src/dashboard/session.js";
import { initialized, tempDb } from "../helpers.js";
import { REMOTE_ORIGIN } from "../fixtures/remote-approval-support.js";

function staticRoot(): string {
  const root = dirname(tempDb());
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "index.html"), "<!doctype html><title>JARVIS</title>");
  return root;
}

describe("remote approval production CLI composition", () => {
  it("exposes enroll, options, and verify on createDashboardServer without an injected service", async () => {
    const db = await initialized();
    const now = new Date();
    const session = createDashboardSession();
    const server = createDashboardServer({
      db, staticRoot: staticRoot(), host: "127.0.0.1", port: 0, sessionStore: session, clock: () => now,
    });
    const host = `127.0.0.1:${String(server.address.port)}`;
    const origin = `http://${host}`;
    const csrf = session.snapshot().csrf_token;
    try {
      const enroll = await request(`http://${host}/api/v1/security/webauthn/enrollments`, {
        method: "POST",
        headers: { host, origin, "content-type": "application/json", "x-jarvis-csrf": csrf },
        body: JSON.stringify({ schema_version: 1 }),
      });
      expect(enroll.statusCode).not.toBe(404);
      expect(enroll.statusCode).toBe(200);
      const enrollBody = await enroll.body.json() as { enrollment_id: string; request_id: string };
      expect(enrollBody.enrollment_id.length).toBeGreaterThan(0);
      expect(enrollBody.request_id.length).toBeGreaterThan(0);

      const options = await request(`http://${host}/api/v1/remote-approvals/manual-qa/options`, {
        method: "POST",
        headers: { host, origin: REMOTE_ORIGIN, "content-type": "application/json" },
        body: JSON.stringify({ schema_version: 1, decision: "approve" }),
      });
      expect(options.statusCode).not.toBe(404);
      await options.body.text();

      const verify = await request(`http://${host}/api/v1/remote-approvals/challenge-x/verify`, {
        method: "POST",
        headers: { host, origin, "content-type": "application/json", "x-jarvis-csrf": csrf },
        body: JSON.stringify({ schema_version: 1, credential: { id: "nope" } }),
      });
      expect(verify.statusCode).not.toBe(404);
      expect(verify.statusCode).toBeGreaterThanOrEqual(400);
      expect((db.db.prepare("SELECT COUNT(*) AS n FROM control_command_receipts").get() as { n: number }).n).toBe(0);
    } finally {
      server.close();
      db.close();
    }
  });

  it("exposes the same routes from startDashboardCli and still refuses session-only minting", async () => {
    const prepared = await initialized();
    const dbPath = prepared.filename;
    prepared.close();
    const root = staticRoot();
    let origin = "";
    const runtime = startDashboardCli({ host: "127.0.0.1", port: 0, dbPath, staticRoot: root }, line => {
      origin = line;
    });
    try {
      const sessionRes = await request(`${origin}/api/v1/session`);
      expect(sessionRes.statusCode).toBe(200);
      const sessionBody = await sessionRes.body.json() as { csrf_token: string };
      const host = origin.replace("http://", "");
      const enroll = await request(`${origin}/api/v1/security/webauthn/enrollments`, {
        method: "POST",
        headers: { host, origin, "content-type": "application/json", "x-jarvis-csrf": sessionBody.csrf_token },
        body: JSON.stringify({ schema_version: 1 }),
      });
      expect(enroll.statusCode).not.toBe(404);
      const options = await request(`${origin}/api/v1/remote-approvals/manual-qa/options`, {
        method: "POST",
        headers: { host, origin: REMOTE_ORIGIN, "content-type": "application/json" },
        body: JSON.stringify({ schema_version: 1, decision: "approve" }),
      });
      expect(options.statusCode).not.toBe(404);
      await options.body.text();
      const verify = await request(`${origin}/api/v1/remote-approvals/challenge-x/verify`, {
        method: "POST",
        headers: {
          host, origin, "content-type": "application/json", "x-jarvis-csrf": sessionBody.csrf_token,
        },
        body: JSON.stringify({ schema_version: 1, credential: { id: "nope" } }),
      });
      expect(verify.statusCode).toBeGreaterThanOrEqual(400);
    } finally {
      runtime.close();
    }
  });
});
