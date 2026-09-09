import type { MemoryProjectionDatabase } from "./memory-projection-types.js";

// SQL fragments are internal constants, never request input. Keep lookups on the lineage indexes.
function blocked(kind: "notification_intent" | "notification_delivery", id: string): string {
  return `EXISTS (SELECT 1 FROM memory_projection_suppressions
    WHERE projection_kind='${kind}' AND projection_id=${id}
    UNION ALL SELECT 1 FROM memory_projection_quarantine
    WHERE projection_kind='${kind}' AND projection_id=${id})`;
}

// Call inside the caller's authority write transaction. Any component blocks its notification.
export function suppressMemoryNotifications(authority: MemoryProjectionDatabase, now: string): boolean {
  const intentBlocked = blocked("notification_intent", "i.intent_id");
  const deliveryBlocked = `(${blocked("notification_delivery", "d.delivery_id")}
    OR ${blocked("notification_intent", "d.intent_id")})`;
  const intents = authority.db.prepare(`
    UPDATE notification_intents AS i SET state='failed',updated_at=?
    WHERE state='delivering' AND (${intentBlocked} OR EXISTS (
      SELECT 1 FROM notification_deliveries d WHERE d.intent_id=i.intent_id
      AND d.state='delivering' AND ${deliveryBlocked}))`).run(now);
  const deliveries = authority.db.prepare(`
    UPDATE notification_deliveries AS d SET state='failed',updated_at=?
    WHERE state='delivering' AND ${deliveryBlocked}`).run(now);
  const pending = authority.db.prepare(`
    UPDATE notification_intents AS i SET state='suppressed',updated_at=?
    WHERE state IN ('created','deferred','queued') AND ${intentBlocked}`).run(now);
  return intents.changes + deliveries.changes + pending.changes > 0;
}
