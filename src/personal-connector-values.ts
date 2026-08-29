import { createHash } from "node:crypto";
import { canonicalize } from "./canonical.js";
import { TERMINAL_SECRET_PATTERN } from "./dashboard/contracts.js";
import type { PersonalConnectorValue, PersonalSourceSnapshot } from "./personal-connector-types.js";

const ID = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,255}$/u;
const DIGEST = /^sha256:[0-9a-f]{64}$/u;
const INSTANT = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u;
const EXTRA_SECRET = /\bxox[baprs]-[A-Za-z0-9-]{8,}/iu;

export function personalConnectorDigest(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalize(value)).digest("hex")}`;
}

export function safeConnectorId(value: string): string {
  if (!ID.test(value) || TERMINAL_SECRET_PATTERN.test(value) || EXTRA_SECRET.test(value)) {
    throw new TypeError("PERSONAL_SOURCE_INVALID");
  }
  return value;
}

export function safeConnectorDigest(value: string): string {
  if (!DIGEST.test(value)) throw new TypeError("PERSONAL_SOURCE_INVALID");
  return value;
}

export function safeConnectorInstant(value: string): string {
  if (!INSTANT.test(value) || !Number.isFinite(Date.parse(value)) || new Date(Date.parse(value)).toISOString() !== value) {
    throw new TypeError("PERSONAL_SOURCE_INVALID");
  }
  return value;
}

export function safeCount(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > 1_000_000) throw new TypeError("PERSONAL_SOURCE_INVALID");
  return value;
}

function freezeValue(value: PersonalConnectorValue): PersonalConnectorValue {
  return Array.isArray(value) ? Object.freeze([...value]) : value;
}

export function freezePersonalSnapshot(snapshot: PersonalSourceSnapshot): PersonalSourceSnapshot {
  const values: Record<string, PersonalConnectorValue> = {};
  for (const [key, value] of Object.entries(snapshot.values)) values[key] = freezeValue(value);
  return Object.freeze({
    ...snapshot,
    evidence_refs: Object.freeze([...snapshot.evidence_refs]),
    values: Object.freeze(values),
  });
}

export function freezePersonalResult<T extends {
  readonly capabilities: readonly string[];
  readonly scopes: readonly string[];
  readonly allowed_fields: readonly string[];
  readonly evidence_refs: readonly string[];
  readonly evidence: object;
  readonly checkpoint_session: object;
  readonly values: Readonly<Record<string, PersonalConnectorValue>>;
}>(result: T): T {
  for (const value of Object.values(result.values)) if (Array.isArray(value)) Object.freeze(value);
  Object.freeze(result.values);
  Object.freeze(result.evidence);
  Object.freeze(result.checkpoint_session);
  Object.freeze(result.capabilities);
  Object.freeze(result.scopes);
  Object.freeze(result.allowed_fields);
  Object.freeze(result.evidence_refs);
  return Object.freeze(result);
}
