import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "undici";
import { describe, expect, it } from "vitest";
import { createDashboardServer } from "../../src/dashboard/server.js";
import { issueEnrollmentCode } from "../../src/owner-inbox-enrollment.js";
import { createPhoneGatewayServer, parsePhoneGatewayConfig } from "../../src/phone-gateway.js";
import { initialized } from "../helpers.js";
import {
  FIXTURE_HOST,
  FIXTURE_LOGIN,
  FIXTURE_ORIGIN,
  cookieFromSetCookie,
  makePhoneHome,
  processUid,
} from "../fixtures/phone-gateway-harness.js";

describe("owner inbox enrollment through the phone gateway", () => {
  it("uses the signed public origin and rejects a forged origin or a missing ingress", async () => {
    const files = makePhoneHome();
    const previousOrigin = process.env.JARVIS_REMOTE_PUBLIC_ORIGIN;
    const previousKey = process.env.JARVIS_REMOTE_INGRESS_KEY_FILE;
    process.env.JARVIS_REMOTE_PUBLIC_ORIGIN = FIXTURE_ORIGIN;
    process.env.JARVIS_REMOTE_INGRESS_KEY_FILE = files.keyFile;
    const db = await initialized();
    const root = mkdtempSync(join(tmpdir(), "owner-inbox-phone-"));
    writeFileSync(join(root, "index.html"), "<!doctype html>");
    let seen: { origin: string; rpId: string } | undefined;
    const dashboard = createDashboardServer({
      db, staticRoot: root, host: "127.0.0.1", port: 0,
      enrollmentCheck: async (input) => {
        seen = { origin: input.expectedOrigin, rpId: input.expectedRpId };
        return input.expectedOrigin === FIXTURE_ORIGIN && input.expectedRpId === FIXTURE_HOST
          ? { ok: true, publicKey: Buffer.from("pk"), counter: 1 }
          : { ok: false };
      },
    });
    const config = parsePhoneGatewayConfig({ home: files.home, envFile: files.envFile, uid: processUid() });
    const gateway = createPhoneGatewayServer({
      host: "127.0.0.1", port: 0, upstream: `http://127.0.0.1:${dashboard.address.port}`,
      staticRoot: root, config,
    });
    const gatewayOrigin = `http://127.0.0.1:${gateway.address.port}`;
    try {
      const session = await request(`${gatewayOrigin}/api/v1/phone/session`, {
        headers: { Host: FIXTURE_HOST, "Tailscale-User-Login": FIXTURE_LOGIN },
      });
      expect(session.statusCode).toBe(200);
      const cookie = cookieFromSetCookie(session.headers["set-cookie"]);
      const csrf = (await session.body.json() as { csrf_token: string }).csrf_token;
      const phone = {
        Host: FIXTURE_HOST,
        "Tailscale-User-Login": FIXTURE_LOGIN,
        Origin: FIXTURE_ORIGIN,
        Cookie: `__Host-jarvis-phone=${cookie ?? ""}`,
        "X-JARVIS-CSRF": csrf,
        "content-type": "application/json",
      };
      const listed = await request(`${gatewayOrigin}/api/v1/owner-inbox`, { headers: phone });
      expect(listed.statusCode).toBe(200);
      const issued = issueEnrollmentCode(db);
      const options = await request(`${gatewayOrigin}/api/v1/owner-inbox/enroll`, {
        method: "POST", headers: phone,
        body: JSON.stringify({ schema_version: 1, enrollment_code: issued.code, phase: "options" }),
      });
      expect(options.statusCode).toBe(200);
      const optionsBody = await options.body.json() as { rp: { id: string }; challenge: string };
      expect(optionsBody.rp.id).toBe(FIXTURE_HOST);
      expect(optionsBody.challenge.length).toBeGreaterThan(0);
      const enrolled = await request(`${gatewayOrigin}/api/v1/owner-inbox/enroll`, {
        method: "POST", headers: phone,
        body: JSON.stringify({
          schema_version: 1, enrollment_code: issued.code,
          attestation: { id: "cred", clientDataJSON: "e30", attestationObject: "e30" },
        }),
      });
      expect(enrolled.statusCode).toBe(200);
      expect(await enrolled.body.json()).toMatchObject({ credential_id: "cred" });
      expect(seen).toEqual({ origin: FIXTURE_ORIGIN, rpId: FIXTURE_HOST });
      const forged = await request(`${gatewayOrigin}/api/v1/owner-inbox/enroll`, {
        method: "POST", headers: { ...phone, Origin: "https://evil.example" },
        body: JSON.stringify({ schema_version: 1, enrollment_code: "unused", phase: "options" }),
      });
      expect(forged.statusCode).toBe(403);
      const missing = await request(`http://127.0.0.1:${dashboard.address.port}/api/v1/owner-inbox/enroll`, {
        method: "POST",
        headers: { host: `127.0.0.1:${dashboard.address.port}`, "content-type": "application/json" },
        body: JSON.stringify({ schema_version: 1, enrollment_code: "unused", phase: "options" }),
      });
      expect(missing.statusCode).toBe(401);
    } finally {
      gateway.close();
      dashboard.close();
      db.close();
      if (previousOrigin === undefined) delete process.env.JARVIS_REMOTE_PUBLIC_ORIGIN;
      else process.env.JARVIS_REMOTE_PUBLIC_ORIGIN = previousOrigin;
      if (previousKey === undefined) delete process.env.JARVIS_REMOTE_INGRESS_KEY_FILE;
      else process.env.JARVIS_REMOTE_INGRESS_KEY_FILE = previousKey;
    }
  });
});
