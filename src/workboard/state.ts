export type Disposition = "running" | "waiting" | "blocked" | "failed" | "paused" | "claimed_done" | "verified" | "unknown";
export type AttemptExecution = "running" | "waiting" | "stopped" | "unknown";
export type ActionDelivery = "none" | "cancel_requested" | "delivering" | "delivered" | "uncertain";
export type AttentionEvent = {
  sequence: number;
  disposition: Disposition;
  attempt: AttemptExecution;
  actionDelivery: ActionDelivery;
  receivedAt: string;
  progress: boolean;
};
export type AttentionState = AttentionEvent & { lastProgressReceivedAt: string | null };

export function applyAttentionEvent(previous: AttentionState | null, event: AttentionEvent): AttentionState {
  if (previous && event.sequence <= previous.sequence) return previous;
  return { ...event, lastProgressReceivedAt: event.progress && (!previous || Date.parse(event.receivedAt) >= Date.parse(previous.lastProgressReceivedAt ?? event.receivedAt))
    ? event.receivedAt : previous?.lastProgressReceivedAt ?? null };
}
