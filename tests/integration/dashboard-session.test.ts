import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { request } from "undici";
import { describe, expect, it } from "vitest";
import { AuthorityDb } from "../../src/db.js";
import { createDashboardServer, type DashboardServer } from "../../src/dashboard/server.js";
import { createDashboardSession } from "../../src/dashboard/session.js";

const originOf = (server: DashboardServer): string =>
  `http://${server.address.host}:${server.address.port}`;

function sessionBody(value: unknown): { readonly schema_version: 1; readonly csrf_token: string } {
  if (typeof value !== "object" || value === null) throw new Error("session body must be object");
  const schemaVersion = Reflect.get(value, "schema_version");
  const csrfToken = Reflect.get(value, "csrf_token");
  if (schemaVersion !== 1 || typeof csrfToken !== "string") throw new Error("session body invalid");
  return { schema_version: 1, csrf_token: csrfToken };
}

describe("dashboard local session", () => {
  it("keeps an independently generated authenticated session out of the browser snapshot", () => {
    // Given / When: Linux creates one server-owned dashboard session.
    const session = createDashboardSession();

    // Then: its internal authority identity is stable, opaque, and absent from browser bytes.
    expect(session.authenticatedSessionId()).toMatch(/^dashboard-session:[A-Za-z0-9_-]{43}$/u);
    expect(session.authenticatedSessionId()).toBe(session.authenticatedSessionId());
    expect(JSON.stringify(session.snapshot())).not.toContain(session.authenticatedSessionId());
  });

  it("returns one stable no-store token per server without mutating authority", async () => {
    const root = mkdtempSync(join(tmpdir(), "jarvis-dashboard-session-"));
    writeFileSync(join(root, "index.html"), "<!doctype html><div id=\"root\"></div>", "utf8");
    const db = new AuthorityDb(join(root, "jarvis.sqlite"));
    await db.migrate();
    const first = createDashboardServer({ db, staticRoot: root, host: "127.0.0.1", port: 0 });
    const second = createDashboardServer({ db, staticRoot: root, host: "127.0.0.1", port: 0 });
    const before = db.db.prepare("SELECT total_changes() AS count").pluck().get();
    try {
      const firstResponse = await request(`${originOf(first)}/api/v1/session`);
      const repeatResponse = await request(`${originOf(first)}/api/v1/session`);
      const secondResponse = await request(`${originOf(second)}/api/v1/session`);
      expect(firstResponse.statusCode).toBe(200);
      expect(firstResponse.headers["cache-control"]).toBe("no-store");
      expect(firstResponse.headers["x-request-id"]).toBeTruthy();
      const firstBody = sessionBody(await firstResponse.body.json());
      const repeatBody = sessionBody(await repeatResponse.body.json());
      const secondBody = sessionBody(await secondResponse.body.json());
      expect(firstBody.csrf_token.length).toBeGreaterThanOrEqual(32);
      expect(repeatBody.csrf_token).toBe(firstBody.csrf_token);
      expect(secondBody.csrf_token).not.toBe(firstBody.csrf_token);
      expect(db.db.prepare("SELECT total_changes() AS count").pluck().get()).toBe(before);
    } finally {
      first.close();
      second.close();
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
