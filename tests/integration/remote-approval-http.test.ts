import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tempDb } from "../helpers.js";
import { request } from "undici";
import { afterEach, describe, expect, it } from "vitest";
import { ControlPlane } from "../../src/control-plane.js";
import { createDashboardServer } from "../../src/dashboard/server.js";
import { createDashboardSession } from "../../src/dashboard/session.js";
import { initialized } from "../helpers.js";
import { createRemoteService, workflowRequest } from "../fixtures/remote-approval-support.js";

afterEach(() => undefined);

function staticRoot(): string {
  const root = dirname(tempDb());
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "index.html"), "<!doctype html><title>JARVIS</title>");
  return root;
}

describe("remote approval HTTP admission", () => {
  it("rejects a challenge verify that presents only the local dashboard session", async () => {
    const db = await initialized();
    const now = new Date();
    new ControlPlane(db).stage(workflowRequest("http-session", now), now);
    const service = createRemoteService(db);
    const session = createDashboardSession();
    const server = createDashboardServer({
      db, staticRoot: staticRoot(), host: "127.0.0.1", port: 0, sessionStore: session, remoteApproval: service, clock: () => now,
    });
    const host = `127.0.0.1:${String(server.address.port)}`;
    try {
      const res = await request(`http://${host}/api/v1/remote-approvals/challenge-x/verify`, {
        method: "POST",
        headers: {
          host, origin: `http://${host}`, "content-type": "application/json",
          "x-jarvis-csrf": session.snapshot().csrf_token,
        },
        body: JSON.stringify({ schema_version: 1, credential: { id: "nope" } }),
      });
      expect([400, 401, 403, 404]).toContain(res.statusCode);
      const body = await res.body.json() as { error: { message: string; code: string } };
      expect(body.error.message).toBe("Remote approval unavailable");
      expect((db.db.prepare("SELECT COUNT(*) AS n FROM control_command_receipts").get() as { n: number }).n).toBe(0);
    } finally {
      server.close();
      db.close();
    }
  });
});
