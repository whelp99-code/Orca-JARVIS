import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request as nodeRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "undici";
import { afterEach, describe, expect, it } from "vitest";
import { Recommendations } from "../../src/index.js";
import { createDashboardServer, type DashboardServer } from "../../src/dashboard/server.js";
import { createDashboardSession, type DashboardSessionStore } from "../../src/dashboard/session.js";
import { persistTask18Context, RECOMMENDATION_ID, task18Request } from "../fixtures/recommendation-fixture.js";
import { initialized } from "../helpers.js";

const NOW = new Date("2026-08-28T12:10:00.000Z");
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

type SessionAccess = { matches: number; authenticatedSessionId: number };
async function fixture(authenticatedSessionId = "dashboard-session:test-route-independent") {
  const db = await initialized();
  const context = persistTask18Context(db);
  new Recommendations(db).create(task18Request(context));
  const root = mkdtempSync(join(tmpdir(), "jarvis-task31-route-"));
  roots.push(root);
  writeFileSync(join(root, "index.html"), "<!doctype html><div id=\"root\"></div>", "utf8");
  const base = createDashboardSession(authenticatedSessionId);
  const access: SessionAccess = { matches: 0, authenticatedSessionId: 0 };
  const sessionStore: DashboardSessionStore = {
    snapshot: () => base.snapshot(),
    matches: (candidate) => { access.matches += 1; return base.matches(candidate); },
    authenticatedSessionId: () => { access.authenticatedSessionId += 1; return base.authenticatedSessionId(); },
  };
  const server = createDashboardServer({
    db, staticRoot: root, host: "127.0.0.1", port: 0, clock: () => NOW, sessionStore,
  });
  return { db, server, access, authenticatedSessionId };
}

function origin(server: DashboardServer): string { return `http://${server.address.host}:${server.address.port}`; }

async function csrf(server: DashboardServer): Promise<string> {
  const response = await request(`${origin(server)}/api/v1/session`);
  const value: unknown = JSON.parse(await response.body.text());
  if (typeof value !== "object" || value === null) throw new TypeError("session expected");
  const token = Reflect.get(value, "csrf_token");
  if (typeof token !== "string") throw new TypeError("csrf expected");
  return token;
}

type PostOptions = Readonly<{
  origins?: readonly string[];
  host?: string;
  csrf?: string;
  body?: string;
}>;
async function accept(server: DashboardServer, token: string, options: PostOptions = {}) {
  const body = options.body ?? '{"schema_version":1}';
  const headers = [
    "Host", options.host ?? `${server.address.host}:${server.address.port}`,
    "Content-Type", "application/json",
    "Content-Length", String(Buffer.byteLength(body)),
    "X-Jarvis-Csrf", options.csrf ?? token,
  ];
  for (const value of options.origins ?? [origin(server)]) headers.push("Origin", value);
  return new Promise<{ readonly status: number; readonly body: unknown; readonly text: string }>((resolve, reject) => {
    const outgoing = nodeRequest({
      host: server.address.host,
      port: server.address.port,
      path: `/api/v1/recommendations/${encodeURIComponent(RECOMMENDATION_ID)}/actions/1/accept`,
      method: "POST",
      headers,
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        const bodyValue: unknown = JSON.parse(text);
        resolve({ status: response.statusCode ?? 0, body: bodyValue, text });
      });
    });
    outgoing.on("error", reject);
    outgoing.end(body);
  });
}

function count(serverDb: Awaited<ReturnType<typeof initialized>>, table: string): number {
  const row = serverDb.db.prepare(`SELECT count(*) AS count FROM ${table}`).get();
  if (typeof row !== "object" || row === null) throw new TypeError("count expected");
  return Number(Reflect.get(row, "count"));
}
function allTableCounts(serverDb: Awaited<ReturnType<typeof initialized>>): Readonly<Record<string, number>> {
  const rows = serverDb.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
  return Object.fromEntries(rows.map((row) => {
    if (typeof row !== "object" || row === null) throw new TypeError("table expected");
    const name = String(Reflect.get(row, "name"));
    return [name, count(serverDb, name)];
  }));
}

const PRIVATE = /authenticated_session|dashboard-session|principal|private|secret|csrf|goal|args|budget|deadline|receipt|signature|digest/iu;

describe("Task31 recommendation acceptance route", () => {
  it("stages one redacted pending workflow request for an exact Origin and converges retries", async () => {
    const { db, server, access, authenticatedSessionId } = await fixture();
    try {
      const token = await csrf(server);
      const first = await accept(server, token);
      const duplicate = await accept(server, token);

      expect(first.status).toBe(202);
      expect(duplicate).toEqual(first);
      expect(first.body).toEqual({
        schema_version: 1,
        recommendation_id: RECOMMENDATION_ID,
        action_rank: 1,
        request_id: expect.stringMatching(/^request:recommendation:/u),
        action: "workflow.start",
        state: "pending",
      });
      expect(first.text).not.toMatch(PRIVATE);
      const stored = db.db.prepare("SELECT args_json FROM control_command_requests LIMIT 1").get();
      if (typeof stored !== "object" || stored === null) throw new TypeError("staged args expected");
      const args = String(Reflect.get(stored, "args_json"));
      expect(args).toContain(authenticatedSessionId);
      expect(args).not.toContain("session:test-operator");
      expect(access).toEqual({ matches: 2, authenticatedSessionId: 2 });
      expect(count(db, "control_command_requests")).toBe(1);
      expect(count(db, "workflow_runs")).toBe(0);
      expect(count(db, "control_command_effects")).toBe(0);
      expect(count(db, "control_effect_attempts")).toBe(0);
    } finally { server.close(); db.close(); }
  });

  it.each([
    ["missing", []],
    ["wrong scheme", ["https://127.0.0.1:PORT"]],
    ["wrong host", ["http://localhost:PORT"]],
    ["wrong port", ["http://127.0.0.1:1"]],
    ["null", ["null"]],
    ["comma joined", ["ORIGIN, ORIGIN"]],
    ["whitespace ambiguous", ["ORIGIN ORIGIN"]],
    ["duplicate exact", ["ORIGIN", "ORIGIN"]],
    ["multiple different", ["ORIGIN", "http://127.0.0.1:1"]],
  ] as const)("rejects %s Origin before body parse or session access", async (_name, templates) => {
    const { db, server, access } = await fixture();
    try {
      const token = await csrf(server);
      const expectedOrigin = origin(server);
      const origins = templates.map((value) => value.replaceAll("ORIGIN", expectedOrigin).replace("PORT", String(server.address.port)));
      const before = allTableCounts(db);
      const rejected = await accept(server, token, { origins, body: "{" });

      expect(rejected.status).toBe(403);
      expect(rejected.body).toMatchObject({ schema_version: 1, error: { code: "LOCAL_SESSION_REQUIRED", message: "Local session required" } });
      expect(rejected.text).not.toMatch(PRIVATE);
      expect(access).toEqual({ matches: 0, authenticatedSessionId: 0 });
      expect(allTableCounts(db)).toEqual(before);
    } finally { server.close(); db.close(); }
  });

  it.each([
    ["wrong Host", { host: "evil.example" }, 0],
    ["wrong CSRF", { csrf: "x".repeat(43), body: "{" }, 1],
  ] as const)("rejects %s with the same generic 403 and zero table delta", async (_name, options, csrfChecks) => {
    const { db, server, access } = await fixture();
    try {
      const token = await csrf(server);
      const before = allTableCounts(db);
      const rejected = await accept(server, token, options);

      expect(rejected.status).toBe(403);
      expect(rejected.body).toMatchObject({ schema_version: 1, error: { code: "LOCAL_SESSION_REQUIRED", message: "Local session required" } });
      expect(rejected.text).not.toMatch(PRIVATE);
      expect(access).toEqual({ matches: csrfChecks, authenticatedSessionId: 0 });
      expect(allTableCounts(db)).toEqual(before);
    } finally { server.close(); db.close(); }
  });

  it("rejects authority bytes and terminal recommendation state before request creation", async () => {
    const { db, server } = await fixture();
    try {
      const token = await csrf(server);
      const malformed = await accept(server, token, { body: '{"schema_version":1,"principal_id":"attacker"}' });
      expect(malformed.status).toBe(400);
      expect(count(db, "control_command_requests")).toBe(0);
    } finally { server.close(); db.close(); }
  });
});
