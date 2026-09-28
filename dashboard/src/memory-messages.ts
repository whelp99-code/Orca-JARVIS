import { MemoryRequestError } from "./memory-api.js";

/** Announced outcome of a staged record command. `stale` means the selection must be searched again. */
export type MemoryCommandOutcome = { readonly kind: "staged" | "stale" | "failed"; readonly message: string };
const STALE_CODES = new Set(["MEMORY_SELECTION_STALE", "MEMORY_SELECTION_EXPIRED", "MEMORY_GENERATION_CHANGED",
  "MEMORY_TOMBSTONE_STALE", "MEMORY_RESOURCE_NOT_FOUND"]);
/** Safe copy per machine code; the API message field never renders. */
const FAILURE_COPY: Readonly<Record<string, string>> = {
  MEMORY_CONTENT_PROHIBITED: "Replacement text contains prohibited content and was not staged.",
  MEMORY_EFFECT_SERVICE_UNAVAILABLE: "Memory changes are unavailable while the provider is read-only or offline.",
  MEMORY_INTENT_REPLAY_CONFLICT: "A matching command is already pending owner approval.",
  MEMORY_STATE_CONFLICT: "A matching command is already pending owner approval.",
  MEMORY_INTENT_EXPIRED: "The command window expired before staging. Try again.",
  MEMORY_POLICY_FORBIDDEN: "Policy does not allow this change.",
  MEMORY_SENSITIVE_REDACTED: "This record is redacted and cannot be changed here.",
};
export const STALE_SELECTION_MESSAGE = "This record changed since it was loaded. Search again before acting.";
export const COMMAND_FAILED_MESSAGE = "Command could not be prepared. Refresh memory and try again.";
export const PENDING_APPROVAL_MESSAGE = "Pending owner approval";

export function memoryCommandFailure(error: unknown): MemoryCommandOutcome {
  if (!(error instanceof MemoryRequestError)) return { kind: "failed", message: COMMAND_FAILED_MESSAGE };
  if (STALE_CODES.has(error.code)) return { kind: "stale", message: STALE_SELECTION_MESSAGE };
  return { kind: "failed", message: FAILURE_COPY[error.code] ?? COMMAND_FAILED_MESSAGE };
}
