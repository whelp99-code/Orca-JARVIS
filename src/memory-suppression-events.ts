import type { AuthorityDb } from "./db.js";
import { MemoryProjectionAuthority } from "./memory-projection-authority.js";
import type { MemorySuppressionEvent } from "./memory-projection-types.js";

export type MemorySuppressionListener = (event: MemorySuppressionEvent) => void;

const listeners = new WeakMap<AuthorityDb, Set<MemorySuppressionListener>>();

export function subscribeMemorySuppression(
  authority: AuthorityDb,
  listener: MemorySuppressionListener,
): () => void {
  const registered = listeners.get(authority) ?? new Set<MemorySuppressionListener>();
  registered.add(listener);
  listeners.set(authority, registered);
  return () => {
    registered.delete(listener);
    if (registered.size === 0) listeners.delete(authority);
  };
}

export function publishMemorySuppression(
  authority: AuthorityDb,
  sequence: number,
  now: Date,
): MemorySuppressionEvent {
  const event = new MemoryProjectionAuthority(authority).markPublished(sequence, now);
  for (const listener of listeners.get(authority) ?? []) listener(event);
  return event;
}
