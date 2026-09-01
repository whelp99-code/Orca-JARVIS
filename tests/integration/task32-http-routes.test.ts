import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "undici";
import { afterEach, describe, expect, it } from "vitest";
import { AuthorityDb } from "../../src/db.js";
import { createDashboardServer, type DashboardServer } from "../../src/dashboard/server.js";
import { tempDb } from "../helpers.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

async function fixture(): Promise<{ readonly db: AuthorityDb; readonly server: DashboardServer }> {
  const db = new AuthorityDb(tempDb());
  await db.migrate();
  const root = mkdtempSync(join(tmpdir(), "task32-memory-http-"));
  roots.push(root);
  writeFileSync(join(root, "index.html"), "<!doctype html><div id=\"root\"></div>");
  return { db, server: createDashboardServer({ db, staticRoot: root, host: "127.0.0.1", port: 0,
    clock: () => new Date("2026-09-01T00:00:00.000Z") }) };
}
function base(server: DashboardServer): string { return `http://${server.address.host}:${server.address.port}`; }
async function csrf(server: DashboardServer): Promise<string> {
  const response = await request(`${base(server)}/api/v1/session`);
  const body: unknown = JSON.parse(await response.body.text());
  const token = typeof body === "object" && body !== null ? Reflect.get(body, "csrf_token") : undefined;
  if (typeof token !== "string") throw new TypeError("session token required");
  return token;
}

async function get(server: DashboardServer, path: string, token?: string) {
  const response = await request(`${base(server)}${path}`, { headers: token === undefined ? {}
    : { "X-JARVIS-CSRF": token } });
  const body: unknown = JSON.parse(await response.body.text());
  return { status: response.statusCode, headers: response.headers, body };
}

describe("Task 32 Memory HTTP boundary", () => {
  it("migrates the three dynamically allocated content-free authority slots", async () => {
    // Given / When
    const { db, server } = await fixture();
    try {
      const migrations = (db.db.prepare("SELECT id FROM schema_migrations WHERE id>='052_' ORDER BY id")
        .all() as Array<{ readonly id: string }>).map(row => row.id);
      // Then
      expect(migrations).toEqual(["052_memory_effect_content_free.sql",
        "053_memory_surface_authority.sql", "054_memory_export_lifecycle.sql"]);
      const names = (db.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as
        Array<{ readonly name: string }>).map(row => row.name);
      expect(names).toEqual(expect.arrayContaining(["memory_surface_authority",
        "memory_surface_target_versions", "memory_surface_effect_attempts",
        "memory_candidate_decision_attempts", "memory_export_lifecycle_observations"]));
    } finally { server.close(); db.close(); }
  });

  it("requires current owner CSRF on Memory GET routes and emits private headers", async () => {
    // Given
    const { db, server } = await fixture();
    try {
      const token = await csrf(server);
      // When
      const denied = await get(server, "/api/v1/memory/status");
      const accepted = await get(server, "/api/v1/memory/status", token);
      // Then
      expect(denied.status).toBe(403);
      expect(accepted.status).toBe(200);
      expect(accepted.headers["cache-control"]).toBe("no-store");
      expect(accepted.headers["x-content-type-options"]).toBe("nosniff");
      expect(JSON.stringify(accepted.body)).not.toMatch(/(?:\/home\/|\/Users\/|\/Volumes\/|private key)/i);
    } finally { server.close(); db.close(); }
  });

  it("exposes exactly twelve bounded routes without vault browsing or downloads", async () => {
    // Given
    const { db, server } = await fixture();
    try {
      const token = await csrf(server);
      const paths = ["/api/v1/memory/status", "/api/v1/memory/conflicts?limit=1",
        "/api/v1/memory/candidates?state=awaiting_confirmation&limit=1",
        "/api/v1/memory/effects?operation=export&state=pending_approval&limit=1"];
      // When
      const responses = await Promise.all(paths.map(path => get(server, path, token)));
      // Then
      expect(responses.map(item => item.status)).toEqual([200, 200, 200, 200]);
      expect(responses.every(item => !JSON.stringify(item.body).match(/(?:vault|download|embedding|path)/i)))
        .toBe(true);
    } finally { server.close(); db.close(); }
  });
});
