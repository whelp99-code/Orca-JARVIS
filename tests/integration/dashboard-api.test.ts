import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { request } from "undici";
import { afterAll, describe, expect, it } from "vitest";
import { AuthorityDb, LiveSupervisor } from "../../src/index.js";
import { createDashboardServer } from "../../src/dashboard/server.js";
import type { DashboardServer } from "../../src/dashboard/server.js";
import type { OverviewResponse } from "../../src/dashboard/read-model.js";
import type { DashboardErrorEnvelope } from "../../src/dashboard/http.js";
import { tempDb } from "../helpers.js";

const FIXTURE_HTML = "<!doctype html><html><head><title>JARVIS Control Center</title></head><body><div id=\"root\"></div></body></html>";

const temporaryDirectories = new Set<string>();

async function migratedDb(): Promise<AuthorityDb> {
  const db = new AuthorityDb(tempDb());
  await db.migrate();
  temporaryDirectories.add(dirname(db.filename));
  return db;
}

afterAll(() => {
  for (const directory of temporaryDirectories) rmSync(directory, { recursive: true, force: true });
});

async function registerAgent(db: AuthorityDb): Promise<void> {
  const worktree = join(mkdtempSync(join(tmpdir(), "jarvis-dashboard-agent-")), "worktree");
  mkdirSync(worktree);
  temporaryDirectories.add(dirname(worktree));
  new LiveSupervisor(db).register(
    { worktree, provider: "codex", terminal_id: "terminal-1", session_id: "session-1", incarnation_id: "incarnation-1", project_id: "dashboard-project" },
    "2026-08-18T00:00:00.000Z",
  );
}

const serverOrigin = (server: DashboardServer): string => {
  const address = server.address;
  if (address.family === "IPv6") throw new Error("dashboard server must bind loopback IPv4 only");
  return `http://${address.host}:${address.port}`;
};

const totalChanges = (db: AuthorityDb): number =>
  Number((db.db.prepare("SELECT total_changes() AS count").get() as { count: number }).count);

const parseJson = (text: string): unknown => JSON.parse(text);

describe("dashboard HTTP overview walking skeleton", () => {
  it("serves health with authority ready and a request id without mutating the database", async () => {
    const db = await migratedDb();
    const root = mkdtempSync(join(tmpdir(), "jarvis-dashboard-static-"));
    writeFileSync(join(root, "index.html"), FIXTURE_HTML, "utf8");
    const server = createDashboardServer({ db, staticRoot: root, host: "127.0.0.1", port: 0 });
    const origin = serverOrigin(server);
    const before = totalChanges(db);
    try {
      const response = await request(`${origin}/api/v1/health`);
      expect(response.statusCode).toBe(200);
      const body = parseJson(await response.body.text());
      expect(body).toMatchObject({ schema_version: 1, status: "ok", authority: "ready", generated_at: expect.any(String) });
      expect(totalChanges(db)).toBe(before);
      expect(response.headers["x-request-id"]).toBeTruthy();
    } finally {
      server.close();
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
    
  });

  it("serves an empty schema-versioned overview plus existing agents without mutating the database", async () => {
    const db = await migratedDb();
    await registerAgent(db);
    const root = mkdtempSync(join(tmpdir(), "jarvis-dashboard-static-"));
    writeFileSync(join(root, "index.html"), FIXTURE_HTML, "utf8");
    const server = createDashboardServer({ db, staticRoot: root, host: "127.0.0.1", port: 0 });
    const origin = serverOrigin(server);
    const before = totalChanges(db);
    try {
      const response = await request(`${origin}/api/v1/overview`);
      expect(response.statusCode).toBe(200);
      const body = parseJson(await response.body.text()) as OverviewResponse;
      expect(body.schema_version).toBe(1);
      expect(body.cards).toEqual([]);
      expect(body.recent_tasks).toEqual([]);
      expect(body.pending_approvals).toEqual([]);
      expect(body.risks).toEqual([]);
      expect(body.agents).toHaveLength(1);
      expect(body.agents[0]).toMatchObject({ provider: "codex", terminal_id: "terminal-1", incarnation_id: "incarnation-1" });
      expect(totalChanges(db)).toBe(before);
      expect(response.headers["x-request-id"]).toBeTruthy();
    } finally {
      server.close();
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
    
  });

  it("serves the fixture html at the root and at a deep task route", async () => {
    const db = await migratedDb();
    const root = mkdtempSync(join(tmpdir(), "jarvis-dashboard-static-"));
    writeFileSync(join(root, "index.html"), FIXTURE_HTML, "utf8");
    const server = createDashboardServer({ db, staticRoot: root, host: "127.0.0.1", port: 0 });
    const origin = serverOrigin(server);
    try {
      for (const path of ["/", "/tasks/task-1"]) {
        const response = await request(`${origin}${path}`);
        expect(response.statusCode).toBe(200);
        expect(await response.body.text()).toBe(FIXTURE_HTML);
      }
    } finally {
      server.close();
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("returns a typed 404 envelope for an unknown api route", async () => {
    const db = await migratedDb();
    const root = mkdtempSync(join(tmpdir(), "jarvis-dashboard-static-"));
    writeFileSync(join(root, "index.html"), FIXTURE_HTML, "utf8");
    const server = createDashboardServer({ db, staticRoot: root, host: "127.0.0.1", port: 0 });
    const origin = serverOrigin(server);
    try {
      const response = await request(`${origin}/api/v1/nonexistent`);
      expect(response.statusCode).toBe(404);
      const body = parseJson(await response.body.text()) as DashboardErrorEnvelope;
      expect(body.schema_version).toBe(1);
      expect(body.error.code).toBe("NOT_FOUND");
      expect(body.error.message).toBeTruthy();
      expect(body.error.request_id).toBeTruthy();
    } finally {
      server.close();
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects a non-loopback host header with a safe 403 envelope", async () => {
    const db = await migratedDb();
    const root = mkdtempSync(join(tmpdir(), "jarvis-dashboard-static-"));
    writeFileSync(join(root, "index.html"), FIXTURE_HTML, "utf8");
    const server = createDashboardServer({ db, staticRoot: root, host: "127.0.0.1", port: 0 });
    const origin = serverOrigin(server);
    try {
      const response = await request(`${origin}/api/v1/health`, { headers: { host: "evil.example" } });
      expect(response.statusCode).toBe(403);
      const body = parseJson(await response.body.text()) as DashboardErrorEnvelope;
      expect(body.schema_version).toBe(1);
      expect(body.error.code).toBe("LOCAL_SESSION_REQUIRED");
      expect(body.error.message).toBeTruthy();
      expect(body.error.request_id).toBeTruthy();
    } finally {
      server.close();
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("binds an ephemeral loopback port, exposes the concrete origin, and closes deterministically", async () => {
    const db = await migratedDb();
    const root = mkdtempSync(join(tmpdir(), "jarvis-dashboard-static-"));
    writeFileSync(join(root, "index.html"), FIXTURE_HTML, "utf8");
    const server = createDashboardServer({ db, staticRoot: root, host: "127.0.0.1", port: 0 });
    const address = server.address;
    expect(address.host).toBe("127.0.0.1");
    expect(address.port).toBeGreaterThan(0);
    expect(serverOrigin(server)).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    server.close();
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
});
