import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { request } from "undici";
import { afterEach, describe, expect, it } from "vitest";
import { AuthorityDb, Recommendations } from "../../src/index.js";
import { createDashboardServer, type DashboardServer } from "../../src/dashboard/server.js";
import { tempDb } from "../helpers.js";
import { persistTask18Context, RECOMMENDATION_ID, RECOMMENDATION_NOW, task18Request } from "../fixtures/recommendation-fixture.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

async function fixture(): Promise<{ readonly db: AuthorityDb; readonly server: DashboardServer }> {
  const db = new AuthorityDb(tempDb());
  await db.migrate();
  roots.push(dirname(db.filename));
  const root = mkdtempSync(join(tmpdir(), "jarvis-personal-read-"));
  roots.push(root);
  writeFileSync(join(root, "index.html"), "<!doctype html><div id=\"root\"></div>", "utf8");
  const server = createDashboardServer({ db, staticRoot: root, host: "127.0.0.1", port: 0,
    clock: () => new Date(RECOMMENDATION_NOW) });
  return { db, server };
}

function origin(server: DashboardServer): string { return `http://${server.address.host}:${server.address.port}`; }
async function call(server: DashboardServer, path: string, method = "GET") {
  const response = await request(`${origin(server)}${path}`, { method });
  const body: unknown = JSON.parse(await response.body.text());
  return { status: response.statusCode, body };
}
function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("record expected");
  return Object.fromEntries(Object.entries(value));
}
function tableCounts(db: AuthorityDb): string {
  const tables = db.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
  return JSON.stringify(tables.map((value) => {
    const row = record(value);
    const name = String(row["name"]);
    return [name, record(db.db.prepare(`SELECT count(*) AS count FROM "${name}"`).get())["count"]];
  }));
}

describe("personal operating dashboard reads", () => {
  it("returns explicit no-data resources without changing any migrated table", async () => {
    // Given
    const { db, server } = await fixture();
    const before = tableCounts(db);
    try {
      // When
      const paths = ["/api/v1/today", "/api/v1/daily-runs", "/api/v1/decision-inbox",
        "/api/v1/notification-intents", "/api/v1/source-health"];
      const responses = await Promise.all(paths.map((path) => call(server, path)));
      // Then
      expect(responses.map((item) => item.status)).toEqual([200, 200, 200, 200, 200]);
      expect(responses.map((item) => record(item.body)["schema_version"])).toEqual([1, 1, 1, 1, 1]);
      expect(tableCounts(db)).toBe(before);
    } finally { server.close(); db.close(); }
  });

  it("projects verified recommendation and exact context evidence without raw memory", async () => {
    // Given
    const { db, server } = await fixture();
    const context = persistTask18Context(db);
    new Recommendations(db).create(task18Request(context));
    const before = tableCounts(db);
    try {
      // When
      const detail = await call(server, `/api/v1/recommendations/${encodeURIComponent(RECOMMENDATION_ID)}`);
      const evidencePath = `/api/v1/contexts/${encodeURIComponent(context.id)}`
        + `/evidence?recommendation_id=${encodeURIComponent(RECOMMENDATION_ID)}`;
      const evidence = await call(server, evidencePath);
      // Then
      expect(detail.status).toBe(200);
      expect(record(detail.body)["recommendation_id"]).toBe(RECOMMENDATION_ID);
      expect(record(detail.body)["conflicts"]).toEqual(["calendar and customer dates differ"]);
      expect(evidence.status).toBe(200);
      expect(record(evidence.body)["context_id"]).toBe(context.id);
      expect(JSON.stringify([detail.body, evidence.body])).not.toContain("customer-first");
      expect(tableCounts(db)).toBe(before);
    } finally { server.close(); db.close(); }
  });

  it("fails closed for malformed queries, foreign cursors, unknown IDs, and unsupported methods", async () => {
    // Given
    const { db, server } = await fixture();
    try {
      // When
      const invalid = await Promise.all([
        call(server, "/api/v1/daily-runs?limit=0"), call(server, "/api/v1/daily-runs?limit=101"),
        call(server, "/api/v1/daily-runs?limit=20&limit=20"), call(server, "/api/v1/daily-runs?unknown=1"),
        call(server, "/api/v1/daily-runs?cursor=not-a-cursor"), call(server, "/api/v1/recommendations/missing"),
        call(server, "/api/v1/today", "PUT"),
      ]);
      // Then
      expect(invalid.map((item) => item.status)).toEqual([400, 400, 400, 400, 400, 404, 404]);
      expect(record(record(invalid[4]?.body)["error"])["code"]).toBe("PERSONAL_CURSOR_INVALID");
      expect(record(record(invalid[5]?.body)["error"])["code"]).toBe("PERSONAL_RESOURCE_NOT_FOUND");
    } finally { server.close(); db.close(); }
  });
});
