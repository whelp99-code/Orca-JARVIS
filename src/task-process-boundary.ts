import { JarvisError } from "./db.js";

/** Synchronous check immediately before spawn; asynchronous preparation consumes the same deadline. */
export function taskProcessTimeout(deadline: number, check: (() => number) | undefined, errorCode: string): number {
  const authorized = check?.() ?? Number.MAX_SAFE_INTEGER;
  const remaining = Math.min(Math.floor(deadline - performance.now()), authorized);
  if (!Number.isSafeInteger(remaining) || remaining < 1) throw new JarvisError(errorCode);
  return remaining;
}
