import { containsPrivateMetadata } from "../private-text.js";
import { REDACTED, SECRET_KEY_PATTERN, TERMINAL_SECRET_PATTERN } from "./contracts.js";

const PRIVATE_KEY = /passkey|webauthn|public_key|private_key|credential|signature|terminal|canonical_path|session_id/i;
const INTERNAL_PATH = /(?:^|[\s"'=(])\/(?:home|Users|root|tmp|var|etc)\//u;
const PRIVATE_VALUE = /passkey|webauthn|public[_ -]?key|signing[_ -]?key/iu;
const MAX_DEPTH = 8;
const MAX_STRING_BYTES = 4_096;

export class PersonalProjectionPrivacyError extends Error {
  readonly name = "PersonalProjectionPrivacyError";
  constructor() { super("PERSONAL_PROJECTION_PRIVATE"); }
}

export function sanitizePersonalProjection(value: unknown): unknown {
  return sanitize(value, 0);
}

export function assertSafeIdentifier(value: string): string {
  if (value.length === 0 || Buffer.byteLength(value, "utf8") > 256 || value !== value.normalize("NFC")
    || containsPrivateMetadata(value) || TERMINAL_SECRET_PATTERN.test(value) || INTERNAL_PATH.test(value)
    || [...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) {
    throw new PersonalProjectionPrivacyError();
  }
  return value;
}

function sanitize(value: unknown, depth: number): unknown {
  if (depth > MAX_DEPTH) return REDACTED;
  if (typeof value === "string") {
    if (Buffer.byteLength(value, "utf8") > MAX_STRING_BYTES) return REDACTED;
    return containsPrivateMetadata(value) || TERMINAL_SECRET_PATTERN.test(value) || INTERNAL_PATH.test(value)
      || PRIVATE_VALUE.test(value) ? REDACTED : value;
  }
  if (Array.isArray(value)) return value.map((item) => sanitize(item, depth + 1));
  if (!plainRecord(value)) return value;
  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    output[key] = SECRET_KEY_PATTERN.test(key) || PRIVATE_KEY.test(key) ? REDACTED : sanitize(child, depth + 1);
  }
  return output;
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
