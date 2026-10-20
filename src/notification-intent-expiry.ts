import type { NotificationStoreAuthority } from "./notification-intent-types.js";

/** Expire unclaimed intents and their report projections atomically, without a native client. */
export function expireUnclaimedNotifications(authority: NotificationStoreAuthority, now: string): boolean {
  return authority.db.transaction(() => {
    const expired = authority.db.prepare(
      `UPDATE notification_intents SET state='expired',updated_at=? WHERE state IN ('created','deferred','queued')
       AND julianday(expires_at)<=julianday(?)`,
    ).run(now, now);
    const reports = authority.db.prepare(
      `UPDATE company_report_notifications SET state='failed',delivery_receipt=NULL
       WHERE state='pending' AND intent_id IN (
         SELECT intent_id FROM notification_intents WHERE state='expired'
       )`,
    ).run();
    return expired.changes > 0 || reports.changes > 0;
  }).immediate();
}
