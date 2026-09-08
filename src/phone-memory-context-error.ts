import { JarvisError } from "./db.js";
import { MemoryReferenceError } from "./memory-reference-context.js";
import { PHONE_ERROR_CODES, type PhoneErrorCode } from "./phone-gateway-protocol.js";

/** Closed mapping: internal messages, paths, keys and provider details never leave HTTP. */
export function phoneMemoryContextError(error: unknown): PhoneErrorCode | undefined {
  if (!(error instanceof JarvisError) && !(error instanceof MemoryReferenceError)) return undefined;
  switch (error.code) {
    case "MEMORY_ACCESS_SCOPE_UNAVAILABLE":
    case "MEMORY_REFERENCE_SCOPE_CHANGED": return PHONE_ERROR_CODES.PHONE_MEMORY_SCOPE_FORBIDDEN;
    case "MEMORY_CONTEXT_BUSY": return PHONE_ERROR_CODES.PHONE_CAPACITY_EXCEEDED;
    case "MEMORY_REFERENCE_INPUT_INVALID":
    case "MEMORY_REFERENCE_BUDGET_IMPOSSIBLE": return PHONE_ERROR_CODES.PHONE_REQUEST_INVALID;
    case "MEMORY_REFERENCE_GENERATION_CHANGED":
    case "MEMORY_REFERENCE_PRIVACY_CHANGED":
    case "MEMORY_REFERENCE_SUPPRESSED":
    case "MEMORY_REFERENCE_EXPIRED": return PHONE_ERROR_CODES.PHONE_MEMORY_CONTEXT_CHANGED;
    case "MEMORY_REFERENCE_PROVIDER_UNAVAILABLE":
    case "MEMORY_REFERENCE_PRIVACY_UNAVAILABLE": return PHONE_ERROR_CODES.PHONE_UPSTREAM_UNAVAILABLE;
    case "MEMORY_SCOPED_CONFIG_INVALID":
    case "MEMORY_REFERENCE_CONFIG_AMBIGUOUS":
    case "MEMORY_REFERENCE_KEY_UNAVAILABLE":
    case "MEMORY_READ_FENCE_KEY_UNAVAILABLE": return PHONE_ERROR_CODES.PHONE_NOT_READY;
    default: return undefined;
  }
}
