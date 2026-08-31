import { createHash, createPublicKey, verify, type KeyObject } from "node:crypto";
import { types as utilTypes } from "node:util";
import { canonicalize } from "./canonical.js";
import {
  MEMORY_EFFECT_DOMAINS,
  MEMORY_EFFECT_INSTANT,
  MEMORY_EFFECT_SIGNATURE,
  MemoryEffectValidationError,
} from "./second-brain-effect-v2-contract.js";

export function rejectMemoryEffect(code: string): never {
  throw new MemoryEffectValidationError(code);
}

export function isMemoryEffectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

export function assertExactMemoryEffectKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  code = "EFFECT_REQUEST_INVALID",
): void {
  if (Object.keys(value).sort().join("\0") !== [...keys].sort().join("\0")) {
    rejectMemoryEffect(code);
  }
}

export function snapshotMemoryEffectValue(value: unknown, depth = 0): unknown {
  if (depth > 20 || utilTypes.isProxy(value)) rejectMemoryEffect("EFFECT_REQUEST_INVALID");
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    if (typeof value === "string" && value !== value.normalize("NFC")) {
      rejectMemoryEffect("EFFECT_REQUEST_INVALID");
    }
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value) || !Number.isSafeInteger(value)) {
      rejectMemoryEffect("EFFECT_REQUEST_INVALID");
    }
    return value;
  }
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype
      || Reflect.ownKeys(value).length !== value.length + 1) {
      rejectMemoryEffect("EFFECT_REQUEST_INVALID");
    }
    return value.map(item => snapshotMemoryEffectValue(item, depth + 1));
  }
  if (!isMemoryEffectRecord(value)) rejectMemoryEffect("EFFECT_REQUEST_INVALID");
  const result: Record<string, unknown> = {};
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || key === "__proto__") {
      rejectMemoryEffect("EFFECT_REQUEST_INVALID");
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
      rejectMemoryEffect("EFFECT_REQUEST_INVALID");
    }
    result[key] = snapshotMemoryEffectValue(descriptor.value, depth + 1);
  }
  return result;
}

export function memoryEffectText(
  record: Record<string, unknown>,
  key: string,
  code: string,
): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0 || value !== value.normalize("NFC")) {
    rejectMemoryEffect(code);
  }
  return value;
}

export function memoryEffectInteger(
  record: Record<string, unknown>,
  key: string,
  code: string,
): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value)) rejectMemoryEffect(code);
  return value;
}

export function memoryEffectInstant(value: unknown, code: string): number {
  if (typeof value !== "string" || !MEMORY_EFFECT_INSTANT.test(value)) {
    rejectMemoryEffect(code);
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    rejectMemoryEffect(code);
  }
  return parsed;
}

export function memoryEffectMember<const Values extends readonly string[]>(
  value: unknown,
  values: Values,
  code: string,
): Values[number] {
  if (typeof value !== "string" || !values.includes(value as Values[number])) {
    rejectMemoryEffect(code);
  }
  return value as Values[number];
}

export function memoryEffectJsonDigest(
  domain: keyof typeof MEMORY_EFFECT_DOMAINS,
  value: unknown,
): string {
  return `sha256:${createHash("sha256")
    .update(MEMORY_EFFECT_DOMAINS[domain])
    .update(canonicalize(value))
    .digest("hex")}`;
}

export function memoryEffectDigest(
  domain: keyof typeof MEMORY_EFFECT_DOMAINS,
  value: unknown,
): string {
  return memoryEffectJsonDigest(domain, value);
}

export function withoutMemoryEffectFields(
  value: Record<string, unknown>,
  keys: readonly string[],
): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key)));
}

function memoryEffectKey(value: string | KeyObject): KeyObject | string {
  return typeof value === "string" ? createPublicKey(value) : value;
}

function memoryEffectSignatureBytes(value: unknown, code: string): Buffer {
  if (typeof value !== "string" || !MEMORY_EFFECT_SIGNATURE.test(value)) {
    rejectMemoryEffect(code);
  }
  const result = Buffer.from(value, "base64url");
  if (result.byteLength !== 64) rejectMemoryEffect(code);
  return result;
}

export function verifyMemoryEffectSignature(
  key: string | KeyObject | undefined,
  domain: string,
  body: unknown,
  signature: unknown,
  code: string,
): void {
  if (key === undefined) rejectMemoryEffect(code);
  try {
    if (!verify(
      null,
      Buffer.from(domain + canonicalize(body)),
      memoryEffectKey(key),
      memoryEffectSignatureBytes(signature, code),
    )) rejectMemoryEffect(code);
  } catch (error) {
    if (error instanceof MemoryEffectValidationError) throw error;
    rejectMemoryEffect(code);
  }
}
