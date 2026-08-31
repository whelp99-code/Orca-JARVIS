import { createHash } from "node:crypto";
import { canonicalize } from "./canonical.js";
import { projectMacNotificationPayload } from "./notification-delivery-payload.js";
import { NotificationDeliveryError, type NotificationClaim, type NotificationSettleInput,
  type NotificationSettlement } from "./notification-delivery-types.js";
import type { NotificationStoreAuthority } from "./notification-intent-types.js";

const LEASE_MS = 15 * 60_000;
type Options = {
  readonly authority: NotificationStoreAuthority;
  readonly resourceIsCurrent: (deepLink: string, now: string) => boolean;
};
type IntentRow = {
  readonly intent_id: string; readonly urgency: "info" | "action" | "critical"; readonly redacted_preview: string;
  readonly deep_link: string; readonly expires_at: string;
};
export type NotificationSettleRequest = {
  readonly deliveryId: string; readonly input: NotificationSettleInput; readonly now: string; readonly sessionId: string;
};
type DeliveryRow = {
  readonly delivery_id: string; readonly intent_id: string; readonly state: string; readonly lease_owner: string | null;
  readonly lease_expires_at: string | null; readonly attempt_digest: string; readonly updated_at: string;
};
const hash = (value: unknown): string => createHash("sha256").update(canonicalize(value)).digest("hex");
const digest = (value: unknown): string => `sha256:${hash(value)}`;
function validInstant(value: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    throw new NotificationDeliveryError("NOTIFICATION_DELIVERY_INVALID");
  }
  return parsed;
}
function intentRow(value: unknown): IntentRow {
  if (typeof value !== "object" || value === null) throw new NotificationDeliveryError("NOTIFICATION_DELIVERY_UNAVAILABLE");
  const id = Reflect.get(value, "intent_id"); const urgency = Reflect.get(value, "urgency");
  const preview = Reflect.get(value, "redacted_preview"); const link = Reflect.get(value, "deep_link");
  const expires = Reflect.get(value, "expires_at");
  if (typeof id !== "string" || (urgency !== "info" && urgency !== "action" && urgency !== "critical")
    || typeof preview !== "string" || typeof link !== "string" || typeof expires !== "string") {
    throw new NotificationDeliveryError("NOTIFICATION_DELIVERY_UNAVAILABLE");
  }
  return { intent_id: id, urgency, redacted_preview: preview, deep_link: link, expires_at: expires };
}
function deliveryRow(value: unknown): DeliveryRow {
  if (typeof value !== "object" || value === null) throw new NotificationDeliveryError("NOTIFICATION_DELIVERY_NOT_FOUND");
  const deliveryId = Reflect.get(value, "delivery_id"); const intentId = Reflect.get(value, "intent_id");
  const state = Reflect.get(value, "state"); const owner = Reflect.get(value, "lease_owner");
  const lease = Reflect.get(value, "lease_expires_at"); const attempt = Reflect.get(value, "attempt_digest");
  const updated = Reflect.get(value, "updated_at");
  if (typeof deliveryId !== "string" || typeof intentId !== "string" || typeof state !== "string"
    || (owner !== null && typeof owner !== "string") || (lease !== null && typeof lease !== "string")
    || typeof attempt !== "string" || typeof updated !== "string") {
    throw new NotificationDeliveryError("NOTIFICATION_DELIVERY_UNAVAILABLE");
  }
  return { delivery_id: deliveryId, intent_id: intentId, state, lease_owner: owner,
    lease_expires_at: lease, attempt_digest: attempt, updated_at: updated };
}

export class NotificationDeliveryStore {
  constructor(private readonly options: Options) {}

  claim(now: string, sessionId: string): NotificationClaim | null {
    const epoch = validInstant(now);
    if (sessionId.length === 0) throw new NotificationDeliveryError("NOTIFICATION_DELIVERY_INVALID");
    return this.options.authority.db.transaction(() => {
      this.reconcile(epoch, now);
      for (;;) {
        const value = this.options.authority.db.prepare(
          `SELECT intent_id,urgency,redacted_preview,deep_link,expires_at FROM notification_intents
           WHERE channel='mac' AND state='queued' AND julianday(expires_at)>julianday(?)
           ORDER BY CASE urgency WHEN 'critical' THEN 0 WHEN 'action' THEN 1 ELSE 2 END,created_at,intent_id LIMIT 1`,
        ).get(now);
        if (value === undefined) return null;
        const intent = intentRow(value);
        let payload;
        try {
          if (!this.options.resourceIsCurrent(intent.deep_link, now)) throw new NotificationDeliveryError("NOTIFICATION_DELIVERY_INVALID");
          payload = projectMacNotificationPayload({ urgency: intent.urgency, preview: intent.redacted_preview,
            deepLink: intent.deep_link });
        } catch (error) {
          if (!(error instanceof NotificationDeliveryError)) throw error;
          this.options.authority.db.prepare("UPDATE notification_intents SET state='suppressed',updated_at=? WHERE intent_id=?")
            .run(now, intent.intent_id);
          continue;
        }
        const semantic = { schema_version: 1, intent_id: intent.intent_id, channel: "mac_native" };
        const identity = hash(semantic); const deliveryId = `ndl:pos:v1:${identity}`;
        const idempotencyKey = `idem:notification-delivery:v1:${identity}`;
        const attemptDigest = digest({ schema_version: 1, delivery_id: deliveryId, intent_id: intent.intent_id,
          channel: "mac_native", payload_digest: digest(payload) });
        const lease = new Date(Math.min(epoch + LEASE_MS, validInstant(intent.expires_at))).toISOString();
        this.options.authority.db.prepare(
          `INSERT INTO notification_deliveries(delivery_id,intent_id,idempotency_key,state,attempt_digest,created_at,updated_at)
           VALUES(?,?,?,'created',?,?,?)`,
        ).run(deliveryId, intent.intent_id, idempotencyKey, attemptDigest, now, now);
        this.options.authority.db.prepare("UPDATE notification_deliveries SET state='queued',updated_at=? WHERE delivery_id=?")
          .run(now, deliveryId);
        this.options.authority.db.prepare(
          `UPDATE notification_deliveries SET state='delivering',lease_owner=?,lease_fence=1,lease_expires_at=?,updated_at=?
           WHERE delivery_id=?`,
        ).run(sessionId, lease, now, deliveryId);
        this.options.authority.db.prepare("UPDATE notification_intents SET state='delivering',updated_at=? WHERE intent_id=?")
          .run(now, intent.intent_id);
        const claimed: NotificationClaim = { schema_version: 1, delivery_id: deliveryId, intent_id: intent.intent_id,
          expires_at: intent.expires_at, payload };
        return claimed;
      }
    }).immediate();
  }

  settle(request: NotificationSettleRequest): NotificationSettlement {
    const { deliveryId, input, now, sessionId } = request;
    const epoch = validInstant(now);
    return this.options.authority.db.transaction(() => {
      const row = deliveryRow(this.options.authority.db.prepare(
        `SELECT delivery_id,intent_id,state,lease_owner,lease_expires_at,attempt_digest,updated_at
         FROM notification_deliveries WHERE delivery_id=?`,
      ).get(deliveryId));
      if (row.state === "delivered" || row.state === "failed" || row.state === "expired") {
        if ((row.state === "delivered") !== (input.outcome === "delivered") && row.state !== "expired") {
          throw new NotificationDeliveryError("NOTIFICATION_DELIVERY_REPLAY_CONFLICT");
        }
        return settlement(row, row.state, row.updated_at);
      }
      if (row.state !== "delivering" || row.lease_owner !== sessionId || row.lease_expires_at === null
        || epoch >= validInstant(row.lease_expires_at)) {
        throw new NotificationDeliveryError("NOTIFICATION_DELIVERY_STALE_LEASE");
      }
      const intentValue = this.options.authority.db.prepare("SELECT expires_at FROM notification_intents WHERE intent_id=?")
        .get(row.intent_id);
      const expires = typeof intentValue === "object" && intentValue !== null ? Reflect.get(intentValue, "expires_at") : undefined;
      if (typeof expires !== "string") throw new NotificationDeliveryError("NOTIFICATION_DELIVERY_UNAVAILABLE");
      if (epoch >= validInstant(expires)) {
        this.terminalize(row, "expired", now);
        return settlement(row, "expired", now);
      }
      if (input.outcome === "delivered") {
        const receipt = digest({ schema_version: 1, delivery_id: row.delivery_id, intent_id: row.intent_id,
          attempt_digest: row.attempt_digest, outcome: "delivered" });
        this.options.authority.db.prepare(
          `UPDATE notification_deliveries SET state='delivered',receipt_digest=?,delivered_at=?,updated_at=? WHERE delivery_id=?`,
        ).run(receipt, now, now, row.delivery_id);
        this.options.authority.db.prepare("UPDATE notification_intents SET state='delivered',updated_at=? WHERE intent_id=?")
          .run(now, row.intent_id);
        return settlement(row, "delivered", now);
      }
      this.terminalize(row, "failed", now);
      return settlement(row, "failed", now);
    }).immediate();
  }

  private reconcile(epoch: number, now: string): void {
    const stale = this.options.authority.db.prepare(
      `SELECT delivery_id,intent_id,state,lease_owner,lease_expires_at,attempt_digest,updated_at
       FROM notification_deliveries WHERE state='delivering' AND julianday(lease_expires_at)<=julianday(?)`,
    ).all(now).map(deliveryRow);
    for (const row of stale) this.terminalize(row, "failed", now);
    this.options.authority.db.prepare(
      "UPDATE notification_intents SET state='expired',updated_at=? WHERE state IN ('created','deferred','queued') AND julianday(expires_at)<=julianday(?)",
    ).run(now, now);
    this.options.authority.db.prepare(
      `UPDATE notification_intents SET state='queued',updated_at=? WHERE state='deferred'
       AND julianday(updated_at)<=julianday(?) AND julianday(expires_at)>julianday(?)`,
    ).run(now, now, now);
    void epoch;
  }

  private terminalize(row: DeliveryRow, state: "failed" | "expired", now: string): void {
    this.options.authority.db.prepare(
      "UPDATE notification_deliveries SET state=?,delivered_at=NULL,updated_at=? WHERE delivery_id=?",
    ).run(state, now, row.delivery_id);
    this.options.authority.db.prepare("UPDATE notification_intents SET state=?,updated_at=? WHERE intent_id=?")
      .run(state, now, row.intent_id);
  }
}
function settlement(row: DeliveryRow, state: "delivered" | "failed" | "expired", at: string): NotificationSettlement {
  return { schema_version: 1, delivery_id: row.delivery_id, intent_id: row.intent_id, state, settled_at: at };
}
