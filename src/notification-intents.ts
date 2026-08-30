import { projectOwnerDecisionQueue } from "./decision-queue.js";
import { parseDecisionQueueInput } from "./notification-intent-input.js";
import { NotificationIntentStore } from "./notification-intent-store.js";
import type { DecisionQueueEventSource } from "./notification-intent-types.js";

export { projectOwnerDecisionQueue, NotificationQueueInvariantError } from "./decision-queue.js";
export { parseDecisionQueueInput } from "./notification-intent-input.js";
export { deriveNotificationDecision, NOTIFICATION_CRITICAL_WINDOW_MS, NOTIFICATION_DEBOUNCE_MS } from "./notification-policy.js";
export { NotificationIntentStore } from "./notification-intent-store.js";
export { DECISION_OMISSION_REASONS, NOTIFICATION_ERROR_CODES, NotificationIntentError } from "./notification-intent-types.js";
export type { DecisionCitation, DecisionEvent, DecisionEventState, DecisionOmissionReason, DecisionQueueEventSource,
  DecisionQueueInput, DecisionQueueProjection, DecisionQueueRecord, DecisionQueueState, DecisionSourceState,
  NotificationErrorCode, NotificationPolicyDecision, NotificationUrgency, OwnerDecisionQueueEntry } from "./notification-intent-types.js";

export class DecisionNotificationService {
  constructor(private readonly store: NotificationIntentStore, private readonly source: DecisionQueueEventSource,
    private readonly clock: () => Date) {}
  start(): () => void {
    return this.source.subscribe(value => {
      const now = this.clock().toISOString(); const projection = projectOwnerDecisionQueue(parseDecisionQueueInput(value));
      const activeKeys = new Set(projection.active.map(entry => entry.semantic_key));
      for (const entry of projection.active) this.store.persist(entry, now);
      for (const omitted of projection.omissions) if (!activeKeys.has(omitted.semantic_key)) this.store.suppress(omitted.semantic_key, now);
    });
  }
}
