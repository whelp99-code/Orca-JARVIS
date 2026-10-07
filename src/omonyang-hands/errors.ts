/** Stable error codes for the 오모냥 hands contract. Messages are not part of the contract. */
export const HANDS_ERROR_CODES = [
  "AUTH_REQUIRED",
  "AUTH_IDENTITY",
  "AUTH_TOKEN_MODE",
  "BIND_FORBIDDEN",
  "RATE_LIMITED",
  "APPROVAL_REQUIRED",
  "VALIDATION",
  "NOT_FOUND",
  "CONFLICT",
  "UNAVAILABLE",
  "FORBIDDEN_SEND",
  "AUDIT_FAILED",
] as const;

export type HandsErrorCode = (typeof HANDS_ERROR_CODES)[number];

export class HandsError extends Error {
  constructor(readonly code: HandsErrorCode, message?: string) {
    super(message ?? code);
  }
}
