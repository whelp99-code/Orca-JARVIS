import { describe, expect, it } from "vitest";
import { AuthorityDb } from "../../src/db.js";
import { NotificationDeliveryStore } from "../../src/notification-delivery-store.js";
import { DELIVERY_DEEP_LINK, DELIVERY_EXPIRES as EXPIRES, DELIVERY_NOW as NOW } from "../fixtures/notification-delivery-fixture.js";
import { tempDb } from "../helpers.js";
async function fixture(state: "queued" | "deferred" = "queued", updatedAt = NOW, expiresAt = EXPIRES) {
  const db = new AuthorityDb(tempDb()); await db.migrate();
  db.db.prepare(`INSERT INTO notification_intents(intent_id,correlation_id,idempotency_key,dedup_key,urgency,channel,
    redacted_preview,deep_link,state,expires_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run("ntf:pos:v1:one", "thread:one", "idem:intent:one", "dedup:one", "action", "mac", "Review decision",
      DELIVERY_DEEP_LINK, "created", expiresAt, "2026-08-28T11:00:00.000Z", "2026-08-28T11:00:00.000Z");
  db.db.prepare("UPDATE notification_intents SET state=?,updated_at=? WHERE intent_id=?")
    .run(state, updatedAt, "ntf:pos:v1:one");
  const store = new NotificationDeliveryStore({ authority: db, resourceIsCurrent: () => true });
  return { db, store };
}

describe("notification delivery state", () => {
  it("claims and settles one intent with exact durable identity", async () => {
    // Given
    const { db, store } = await fixture();
    try {
      // When
      const claimed = store.claim(NOW, "dashboard-session:test");
      expect(claimed).not.toBeNull();
      if (claimed === null) return;
      const settled = store.settle({ deliveryId: claimed.delivery_id, input: { schema_version: 1, outcome: "delivered" }, now: NOW,
        sessionId: "dashboard-session:test" });
      // Then
      expect(settled.state).toBe("delivered");
      expect(store.claim(NOW, "dashboard-session:test")).toBeNull();
      expect(db.db.prepare("SELECT state,receipt_digest,delivered_at FROM notification_deliveries").get())
        .toMatchObject({ state: "delivered", delivered_at: NOW });
      expect(db.db.prepare("SELECT state FROM notification_intents").get()).toEqual({ state: "delivered" });
    } finally { db.close(); }
  });

  it("defers before the Linux instant and claims at equality", async () => {
    // Given
    const allowed = "2026-08-28T12:30:00.000Z";
    const { db, store } = await fixture("deferred", allowed);
    try {
      // When / Then
      expect(store.claim("2026-08-28T12:29:59.999Z", "dashboard-session:test")).toBeNull();
      expect(store.claim(allowed, "dashboard-session:test")).not.toBeNull();
    } finally { db.close(); }
  });

  it("settles adapter failure once and rejects a contradictory replay", async () => {
    // Given
    const { db, store } = await fixture();
    try {
      const claimed = store.claim(NOW, "dashboard-session:test");
      expect(claimed).not.toBeNull();
      if (claimed === null) return;
      // When
      const failed = store.settle({ deliveryId: claimed.delivery_id, input: { schema_version: 1, outcome: "failed",
        failure_code: "NOTIFICATIONS_DENIED" }, now: NOW, sessionId: "dashboard-session:test" });
      // Then
      expect(failed.state).toBe("failed");
      expect(() => store.settle({ deliveryId: claimed.delivery_id, input: { schema_version: 1, outcome: "delivered" }, now: NOW,
        sessionId: "dashboard-session:test" })).toThrowError(expect.objectContaining({ code: "NOTIFICATION_DELIVERY_REPLAY_CONFLICT" }));
    } finally { db.close(); }
  });

  it("expires at equality without creating a delivery", async () => {
    // Given
    const { db, store } = await fixture("queued", NOW, NOW);
    try {
      // When / Then
      expect(store.claim(NOW, "dashboard-session:test")).toBeNull();
      expect(db.db.prepare("SELECT state FROM notification_intents").get()).toEqual({ state: "expired" });
      expect(db.db.prepare("SELECT count(*) AS count FROM notification_deliveries").get()).toEqual({ count: 0 });
    } finally { db.close(); }
  });

  it("never replays an uncertain expired lease", async () => {
    // Given
    const { db, store } = await fixture();
    try {
      const claimed = store.claim(NOW, "dashboard-session:test");
      expect(claimed).not.toBeNull();
      // When
      const replay = store.claim("2026-08-28T12:15:00.001Z", "dashboard-session:test");
      // Then
      expect(replay).toBeNull();
      expect(db.db.prepare("SELECT state FROM notification_deliveries").get()).toEqual({ state: "failed" });
      expect(db.db.prepare("SELECT state FROM notification_intents").get()).toEqual({ state: "failed" });
    } finally { db.close(); }
  });
});
