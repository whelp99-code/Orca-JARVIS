import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "undici";
import { describe, expect, it } from "vitest";
import { AuthorityDb, Recommendations } from "../../src/index.js";
import { publishNotificationMutation } from "../../src/dashboard/notification-delivery-routes.js";
import { createDashboardServer } from "../../src/dashboard/server.js";
import { createDashboardSession } from "../../src/dashboard/session.js";
import { persistTask18Context, RECOMMENDATION_ID, RECOMMENDATION_NOW, task18Request } from "../fixtures/recommendation-fixture.js";
import { tempDb } from "../helpers.js";

async function fixture() {
  const db = new AuthorityDb(tempDb()); await db.migrate();
  const context = await persistTask18Context(db); new Recommendations(db).create(task18Request(context));
  const rankRow = db.db.prepare("SELECT rank FROM personal_recommendation_actions WHERE recommendation_id=? ORDER BY rank LIMIT 1")
    .get(RECOMMENDATION_ID);
  const rank = Number(Reflect.get(rankRow ?? {}, "rank"));
  db.db.prepare(`INSERT INTO notification_intents(intent_id,correlation_id,idempotency_key,dedup_key,urgency,channel,
    redacted_preview,deep_link,state,expires_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run("ntf:pos:v1:http", "thread:http", "idem:intent:http", "dedup:http", "action", "mac", "Review decision",
      `/recommendations/${encodeURIComponent(RECOMMENDATION_ID)}?rank=${rank}`, "created", "2026-08-28T12:30:00.000Z",
      "2026-08-28T11:00:00.000Z", "2026-08-28T11:00:00.000Z");
  db.db.prepare("UPDATE notification_intents SET state='queued',updated_at=? WHERE intent_id='ntf:pos:v1:http'")
    .run(RECOMMENDATION_NOW);
  const root = mkdtempSync(join(tmpdir(), "task33-http-")); writeFileSync(join(root, "index.html"), "<!doctype html>");
  const session = createDashboardSession("dashboard-session:task33");
  const server = createDashboardServer({ db, staticRoot: root, host: "127.0.0.1", port: 0, sessionStore: session,
    clock: () => new Date(RECOMMENDATION_NOW) });
  const origin = `http://${server.address.host}:${server.address.port}`;
  return { db, root, server, origin, csrf: session.snapshot().csrf_token };
}
async function post(origin: string, path: string, csrf: string, body: unknown) {
  const response = await request(`${origin}${path}`, { method: "POST", headers: { Origin: origin,
    "X-JARVIS-CSRF": csrf, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return { status: response.statusCode, body: response.statusCode === 204 ? null : await response.body.json() };
}

describe("dashboard notification delivery routes", () => {
  it("publishes only mutations that committed writes", () => {
    // Given
    const published: string[] = []; const hub = { publishPersonal: (kind: string) => { published.push(kind); } };
    // When
    publishNotificationMutation(hub, true); publishNotificationMutation(hub, false);
    // Then
    expect(published).toEqual(["notification"]);
  });

  it("claims and settles through the real session boundary", async () => {
    // Given
    const value = await fixture();
    try {
      // When
      const claim = await post(value.origin, "/api/v1/notification-deliveries/claim", value.csrf, { schema_version: 1 });
      const deliveryId = String(Reflect.get(claim.body ?? {}, "delivery_id"));
      const settle = await post(value.origin, `/api/v1/notification-deliveries/${encodeURIComponent(deliveryId)}/settle`,
        value.csrf, { schema_version: 1, outcome: "delivered" });
      // Then
      expect(claim.status).toBe(200); expect(settle.status).toBe(200);
      expect(Reflect.get(settle.body ?? {}, "state")).toBe("delivered");
      expect((await post(value.origin, "/api/v1/notification-deliveries/claim", value.csrf,
        { schema_version: 1 })).status).toBe(204);
    } finally { value.server.close(); value.db.close(); rmSync(value.root, { recursive: true, force: true }); }
  });

  it("rejects wrong origin before any delivery write", async () => {
    // Given
    const value = await fixture();
    try {
      // When
      const response = await request(`${value.origin}/api/v1/notification-deliveries/claim`, { method: "POST",
        headers: { Origin: "http://127.0.0.1:1", "X-JARVIS-CSRF": value.csrf, "Content-Type": "application/json" },
        body: JSON.stringify({ schema_version: 1 }) });
      // Then
      expect(response.statusCode).toBe(403);
      expect(value.db.db.prepare("SELECT count(*) AS count FROM notification_deliveries").get()).toEqual({ count: 0 });
      await response.body.dump();
    } finally { value.server.close(); value.db.close(); rmSync(value.root, { recursive: true, force: true }); }
  });
});
