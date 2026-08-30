import { createHash } from "node:crypto";
import { canonicalize } from "./canonical.js";
import { deriveNotificationDecision } from "./notification-policy.js";
import { persistenceRow, persistenceText } from "./personal-persistence-values.js";
import { NotificationIntentError, type NotificationPolicyDecision, type NotificationStoreAuthority,
  type OwnerDecisionQueueEntry } from "./notification-intent-types.js";

const hash = (value: unknown): string => createHash("sha256").update(canonicalize(value)).digest("hex");
function material(entry: OwnerDecisionQueueEntry): string {
  return `idem:notification:v1:${hash(entry)}`;
}
const silent = (reason: string): NotificationPolicyDecision => ({ urgency: "silent", state: "suppressed", reason,
  not_before: null, intent_id: null });
export class NotificationIntentStore {
  constructor(private readonly authority: NotificationStoreAuthority) {}
  persist(entry: OwnerDecisionQueueEntry | undefined, clock: string): NotificationPolicyDecision {
    if (entry === undefined) return silent("no_active_owner_decision");
    const expected = material(entry);
    const existingValue = this.authority.db.prepare(
      "SELECT intent_id,idempotency_key,state,created_at FROM notification_intents WHERE dedup_key=?",
    ).get(entry.dedup_key);
    if (existingValue !== undefined) {
      const existing = persistenceRow(existingValue);
      if (persistenceText(existing["idempotency_key"]) !== expected) {
        throw new NotificationIntentError("NOTIFICATION_IDENTITY_CONFLICT");
      }
      return silent(persistenceText(existing["state"]) === "suppressed" ? "terminal_intent_suppressed" : "duplicate_unchanged_state");
    }
    const priorValue = this.authority.db.prepare(
      "SELECT created_at,state FROM notification_intents WHERE correlation_id=? ORDER BY created_at DESC,intent_id DESC LIMIT 1",
    ).get(entry.thread_key);
    const prior = priorValue === undefined ? null : persistenceRow(priorValue);
    const decision = deriveNotificationDecision(entry, clock, prior === null ? null : {
      created_at: persistenceText(prior["created_at"]), state: persistenceText(prior["state"]),
    });
    if (decision.urgency === "silent" || decision.intent_id === null) return decision;
    const persistedUrgency = decision.urgency === "digest" ? "info" : decision.urgency;
    const transitionAt = decision.not_before ?? clock;
    this.authority.db.transaction(() => {
      this.authority.db.prepare(
        `INSERT INTO notification_intents(intent_id,correlation_id,idempotency_key,dedup_key,urgency,channel,
         redacted_preview,deep_link,state,expires_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(decision.intent_id, entry.thread_key, expected, entry.dedup_key, persistedUrgency, "mac", entry.preview,
        entry.deep_link, "created", entry.expires_at, clock, clock);
      this.authority.db.prepare("UPDATE notification_intents SET state=?,updated_at=? WHERE intent_id=?")
        .run(decision.state, transitionAt, decision.intent_id);
    })();
    return decision;
  }
  suppress(semanticKey: string, clock: string): void {
    const dedupKey = `notification:v1:${hash({ semantic_key: semanticKey })}`;
    const rowValue = this.authority.db.prepare("SELECT intent_id,state FROM notification_intents WHERE dedup_key=?").get(dedupKey);
    if (rowValue === undefined) return;
    const row = persistenceRow(rowValue); const state = persistenceText(row["state"]);
    if (state === "created" || state === "deferred" || state === "queued") {
      this.authority.db.prepare("UPDATE notification_intents SET state='suppressed',updated_at=? WHERE intent_id=?")
        .run(clock, persistenceText(row["intent_id"]));
    }
  }
}
