import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "undici";
import { afterEach, describe, expect, it } from "vitest";
import { Recommendations } from "../../src/index.js";
import { createDashboardServer, type DashboardServer } from "../../src/dashboard/server.js";
import { persistTask18Context, RECOMMENDATION_ID, task18Request } from "../fixtures/recommendation-fixture.js";
import { initialized } from "../helpers.js";

const NOW = new Date("2026-08-28T12:10:00.000Z");
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

async function fixture() {
  const db = await initialized();
  const context = persistTask18Context(db);
  new Recommendations(db).create(task18Request(context));
  const root = mkdtempSync(join(tmpdir(), "jarvis-task31-route-"));
  roots.push(root);
  writeFileSync(join(root, "index.html"), "<!doctype html><div id=\"root\"></div>", "utf8");
  const server = createDashboardServer({ db, staticRoot: root, host: "127.0.0.1", port: 0, clock: () => NOW });
  return { db, server };
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

async function accept(server: DashboardServer, token: string, body: unknown) {
  const response = await request(
    `${origin(server)}/api/v1/recommendations/${encodeURIComponent(RECOMMENDATION_ID)}/actions/1/accept`,
    { method: "POST", headers: { "content-type": "application/json", "x-jarvis-csrf": token }, body: JSON.stringify(body) },
  );
  return { status: response.statusCode, body: JSON.parse(await response.body.text()) as unknown };
}

function count(serverDb: Awaited<ReturnType<typeof initialized>>, table: string): number {
  const row = serverDb.db.prepare(`SELECT count(*) AS count FROM ${table}`).get();
  if (typeof row !== "object" || row === null) throw new TypeError("count expected");
  return Number(Reflect.get(row, "count"));
}

describe("Task31 recommendation acceptance route", () => {
  it("stages one redacted pending workflow request when an eligible action is accepted twice", async () => {
    // Given: Linux owns a fresh recommendation and the browser has only its CSRF token.
    const { db, server } = await fixture();
    try {
      const token = await csrf(server);

      // When: the exact minimal acceptance is retried.
      const first = await accept(server, token, { schema_version: 1 });
      const duplicate = await accept(server, token, { schema_version: 1 });

      // Then: one pending request exists and no authority or workflow input is returned.
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
      expect(JSON.stringify(first.body)).not.toMatch(/session|principal|goal|args|budget|deadline|receipt|digest/iu);
      expect(count(db, "control_command_requests")).toBe(1);
      expect(count(db, "workflow_runs")).toBe(0);
      expect(count(db, "control_command_effects")).toBe(0);
    } finally { server.close(); db.close(); }
  });

  it("rejects authority bytes and terminal recommendation state before request creation", async () => {
    // Given: an eligible recommendation and valid local CSRF boundary.
    const { db, server } = await fixture();
    try {
      const token = await csrf(server);

      // When: the browser attempts to send an authority field.
      const malformed = await accept(server, token, { schema_version: 1, principal_id: "attacker" });

      // Then: the closed body fails without a partial request.
      expect(malformed.status).toBe(400);
      expect(count(db, "control_command_requests")).toBe(0);
    } finally { server.close(); db.close(); }
  });
});
