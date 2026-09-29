import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "undici";
import { afterEach, describe, expect, it } from "vitest";
import { ControlPlane } from "../../src/control-plane.js";
import { createDashboardServer } from "../../src/dashboard/server.js";
import { createPhoneGatewayServer, parsePhoneGatewayConfig } from "../../src/phone-gateway.js";
import {
  FIXTURE_HOST, FIXTURE_LOGIN, FIXTURE_ORIGIN, cookieFromSetCookie, makePhoneHome, processUid,
} from "../fixtures/phone-gateway-harness.js";
import { workflowRequest } from "../fixtures/remote-approval-support.js";
import { initialized, localKey } from "../helpers.js";

const roots: string[] = [];
const previous = {
  origin: process.env.JARVIS_REMOTE_PUBLIC_ORIGIN,
  rp: process.env.JARVIS_REMOTE_RP_ID,
  decision: process.env.JARVIS_DECISION_SIGNING_KEY_FILE,
  ingress: process.env.JARVIS_REMOTE_INGRESS_KEY_FILE,
};
afterEach(() => {
  restore("JARVIS_REMOTE_PUBLIC_ORIGIN", previous.origin);
  restore("JARVIS_REMOTE_RP_ID", previous.rp);
  restore("JARVIS_DECISION_SIGNING_KEY_FILE", previous.decision);
  restore("JARVIS_REMOTE_INGRESS_KEY_FILE", previous.ingress);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function restore(name: "JARVIS_REMOTE_PUBLIC_ORIGIN" | "JARVIS_REMOTE_RP_ID" | "JARVIS_DECISION_SIGNING_KEY_FILE" | "JARVIS_REMOTE_INGRESS_KEY_FILE", value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

describe("phone gateway remote approval resolver", () => {
  it("looks up the staged request and mints options only with the matching sealed key", async () => {
    const db = await initialized();
    const files = makePhoneHome();
    roots.push(files.home);
    const keyRoot = mkdtempSync(join(tmpdir(), "jarvis-decision-"));
    roots.push(keyRoot);
    const decisionKey = join(keyRoot, "decision.pem");
    writeFileSync(decisionKey, localKey(db).export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
    chmodSync(decisionKey, 0o600);
    process.env.JARVIS_REMOTE_PUBLIC_ORIGIN = FIXTURE_ORIGIN;
    process.env.JARVIS_REMOTE_RP_ID = FIXTURE_HOST;
    process.env.JARVIS_DECISION_SIGNING_KEY_FILE = decisionKey;
    process.env.JARVIS_REMOTE_INGRESS_KEY_FILE = files.keyFile;
    const staticRoot = join(keyRoot, "static");
    mkdirSync(staticRoot);
    writeFileSync(join(staticRoot, "index.html"), "<!doctype html><head></head><html><body>security</body></html>");
    const now = new Date();
    const staged = new ControlPlane(db).stage(workflowRequest("gw-lookup", now), now);
    const dashboard = createDashboardServer({
      db, staticRoot, host: "127.0.0.1", port: 0, clock: () => now,
    });
    const gateway = createPhoneGatewayServer({
      host: "127.0.0.1", port: 0, upstream: `http://127.0.0.1:${String(dashboard.address.port)}`,
      staticRoot, config: parsePhoneGatewayConfig({ home: files.home, envFile: files.envFile, uid: processUid() }),
      now: () => now.getTime(),
    });
    try {
      expect(dashboard).toBeDefined();
      const session = await request(`http://127.0.0.1:${String(gateway.address.port)}/api/v1/phone/session`, {
        headers: { Host: FIXTURE_HOST, "Tailscale-User-Login": FIXTURE_LOGIN },
      });
      expect(session.statusCode).toBe(200);
      const csrf = (await session.body.json() as { csrf_token: string }).csrf_token;
      const cookie = cookieFromSetCookie(session.headers["set-cookie"]);
      const options = await request(`http://127.0.0.1:${String(gateway.address.port)}/api/v1/remote-approvals/${staged.request_id}/options`, {
        method: "POST",
        headers: {
          Host: FIXTURE_HOST, "Tailscale-User-Login": FIXTURE_LOGIN, Origin: FIXTURE_ORIGIN,
          Cookie: `__Host-jarvis-phone=${cookie ?? ""}`, "X-JARVIS-CSRF": csrf,
          "content-type": "application/json; charset=utf-8",
        },
        body: JSON.stringify({ schema_version: 1, decision: "approve" }),
      });
      const body = await options.body.text();
      expect(options.statusCode, body).toBe(200);
      expect(body).toContain("challenge_id");
      const security = await request(`http://127.0.0.1:${String(gateway.address.port)}/security`, {
        headers: { Host: FIXTURE_HOST, "Tailscale-User-Login": FIXTURE_LOGIN, Cookie: `__Host-jarvis-phone=${cookie ?? ""}` },
      });
      const html = await security.body.text();
      expect(security.statusCode).toBe(200);
      expect(html).toContain("jarvis-phone-mode");
      const forbidden = await request(`http://127.0.0.1:${String(gateway.address.port)}/api/v1/security/webauthn/enrollments`, {
        method: "POST",
        headers: {
          Host: FIXTURE_HOST, "Tailscale-User-Login": FIXTURE_LOGIN, Origin: FIXTURE_ORIGIN,
          Cookie: `__Host-jarvis-phone=${cookie ?? ""}`, "X-JARVIS-CSRF": csrf,
          "content-type": "application/json; charset=utf-8",
        },
        body: JSON.stringify({ schema_version: 1 }),
      });
      expect(forbidden.statusCode).toBe(404);
      await forbidden.body.text();
    } finally {
      gateway.close();
      dashboard.close();
      db.close();
    }
  });
});
