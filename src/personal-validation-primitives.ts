import { canonicalize } from "./canonical.js";
import {
  PERSONAL_CONTRACT_CANONICALIZATION_INVALID,
  PERSONAL_CONTRACT_INVALID,
  PERSONAL_CONTRACT_VERSION_UNSUPPORTED,
  PERSONAL_LIST_ITEMS_MAX,
  PERSONAL_TEXT_BYTES_MAX,
  PERSONAL_VALUE_DEPTH_MAX,
  PERSONAL_VALUE_KEYS_MAX,
  SOURCE_PROVIDERS,
  type CorrelationId,
  type EvidenceId,
  type IdempotencyKey,
  type JsonValue,
  type PersonalEnvelopeV1,
  type Sha256Digest,
  type SourceId,
  type UtcTimestamp,
} from "./personal-contracts.js";

export class PersonalContractError extends Error {
  readonly name = "PersonalContractError";
  constructor(
    readonly code:
      typeof PERSONAL_CONTRACT_INVALID | typeof PERSONAL_CONTRACT_VERSION_UNSUPPORTED | typeof PERSONAL_CONTRACT_CANONICALIZATION_INVALID,
  ) {
    super(code);
  }
}
export const invalid = (): never => {
  throw new PersonalContractError(PERSONAL_CONTRACT_INVALID);
};
const parsedContracts = new WeakSet<object>();
export const ENVELOPE_KEYS = [
  "schema_version",
  "id",
  "created_at",
  "observed_at",
  "valid_at",
  "source",
  "authority",
  "freshness",
  "expires_at",
  "idempotency_key",
  "correlation_id",
  "causation_id",
  "payload",
  "policy_decision",
  "evidence",
  "receipt",
] as const;
const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const SOURCE_ID = /^src:pos:v1:([a-z][a-z0-9-]{1,31}):([a-z0-9][a-z0-9-]{0,63})$/;
const TIMESTAMP = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;
const CORRELATION = /^corr:pos:v1:[0-9a-f-]{36}$/;
const IDEMPOTENCY = /^idem:pos:v1:[a-z0-9][a-z0-9-]{0,63}:[0-9a-f]{64}$/;

export type ParsedBase<Id> = Omit<PersonalEnvelopeV1<Id, never, never>, "payload" | "receipt">;
export type IdParser<Id> = (value: unknown) => Id;
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
export function dataProperties(value: object, array: boolean): readonly string[] {
  const keys = Reflect.ownKeys(value);
  const strings: string[] = [];
  for (const key of keys) {
    if (typeof key !== "string") return invalid();
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      descriptor === undefined ||
      descriptor.get !== undefined ||
      descriptor.set !== undefined ||
      (!descriptor.enumerable && !(array && key === "length"))
    )
      return invalid();
    strings.push(key);
  }
  return strings;
}
export function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value) || Object.getPrototypeOf(value) !== Object.prototype) return invalid();
  dataProperties(value, false);
  return value;
}
export function closed(value: Record<string, unknown>, keys: readonly string[]): void {
  const actual = dataProperties(value, false);
  if (actual.length !== keys.length || actual.some((key) => !keys.includes(key))) invalid();
}
export function safeArray(value: unknown): value is readonly unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return false;
  const keys = dataProperties(value, true);
  if (keys.length !== value.length + 1 || !keys.includes("length")) return false;
  for (let index = 0; index < value.length; index++) if (!keys.includes(String(index))) return false;
  return true;
}
export function literal<const Values extends readonly string[]>(value: unknown, values: Values): Values[number] {
  if (typeof value !== "string") return invalid();
  const match = values.find((candidate) => candidate === value);
  return match ?? invalid();
}
export function text(value: unknown, maximum = PERSONAL_TEXT_BYTES_MAX): string {
  if (
    typeof value !== "string" ||
    value !== value.normalize("NFC") ||
    value.trim().length === 0 ||
    [...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127) ||
    Buffer.byteLength(value, "utf8") > maximum
  )
    return invalid();
  return value;
}
export function nullableText(value: unknown): string | null {
  return value === null ? null : text(value);
}
export function integer(value: unknown, minimum: number, maximum: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum) return invalid();
  return value;
}
export function booleanTrue(value: unknown): true {
  if (value !== true) return invalid();
  return true;
}
export function isDigest(value: unknown): value is Sha256Digest {
  return typeof value === "string" && DIGEST.test(value);
}
export function digest(value: unknown): Sha256Digest {
  return isDigest(value) ? value : invalid();
}
export function nullableDigest(value: unknown): Sha256Digest | null {
  return value === null ? null : digest(value);
}
export function isTimestamp(value: unknown): value is UtcTimestamp {
  return (
    typeof value === "string" && TIMESTAMP.test(value) && Number.isFinite(Date.parse(value)) && new Date(Date.parse(value)).toISOString() === value
  );
}
export function timestamp(value: unknown): UtcTimestamp {
  return isTimestamp(value) ? value : invalid();
}
export function nullableTimestamp(value: unknown): UtcTimestamp | null {
  return value === null ? null : timestamp(value);
}
export function isUuidV7(value: string): boolean {
  return UUID_V7.test(value);
}
export function prefixedId<Name>(value: unknown, prefix: string): Name {
  if (typeof value !== "string" || !value.startsWith(prefix) || !isUuidV7(value.slice(prefix.length))) return invalid();
  function branded(candidate: string): candidate is string & Name {
    return candidate === value;
  }
  return branded(value) ? value : invalid();
}
export function sourceId(value: unknown): SourceId {
  if (typeof value !== "string") return invalid();
  const match = SOURCE_ID.exec(value);
  const provider = match?.[1];
  if (provider === undefined || !SOURCE_PROVIDERS.some((candidate) => candidate === provider)) return invalid();
  function branded(candidate: string): candidate is SourceId {
    return SOURCE_ID.test(candidate);
  }
  return branded(value) ? value : invalid();
}
export function correlation(value: unknown): CorrelationId {
  if (typeof value !== "string" || !CORRELATION.test(value) || !isUuidV7(value.slice("corr:pos:v1:".length))) return invalid();
  function branded(candidate: string): candidate is CorrelationId {
    return CORRELATION.test(candidate);
  }
  return branded(value) ? value : invalid();
}
export function idempotency(value: unknown): IdempotencyKey {
  if (typeof value !== "string" || !IDEMPOTENCY.test(value)) return invalid();
  function branded(candidate: string): candidate is IdempotencyKey {
    return IDEMPOTENCY.test(candidate);
  }
  return branded(value) ? value : invalid();
}
export function evidenceId(value: unknown): EvidenceId {
  return prefixedId<EvidenceId>(value, "evi:pos:v1:");
}
export function list<T>(value: unknown, parse: (item: unknown) => T, unique = true): readonly T[] {
  if (!safeArray(value) || value.length > PERSONAL_LIST_ITEMS_MAX) return invalid();
  const result = value.map(parse);
  if (unique && new Set(result.map((item) => canonicalize(item))).size !== result.length) invalid();
  return result;
}
export function textList(value: unknown): readonly string[] {
  return list(value, (item) => text(item));
}
export function json(value: unknown, depth = 0): JsonValue {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") return text(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value) || !Number.isSafeInteger(value)) return invalid();
    return value;
  }
  if (Array.isArray(value)) {
    if (!safeArray(value) || value.length > PERSONAL_LIST_ITEMS_MAX || depth >= PERSONAL_VALUE_DEPTH_MAX) return invalid();
    return value.map((item) => json(item, depth + 1));
  }
  const input = record(value);
  const keys = Object.keys(input);
  if (
    depth >= PERSONAL_VALUE_DEPTH_MAX ||
    keys.length > PERSONAL_VALUE_KEYS_MAX ||
    keys.some((key) =>
      ["__proto__", "authority", "constructor", "identity", "instructions", "policy", "prototype", "receipt", "source", "tool_scope"].includes(key),
    )
  )
    return invalid();
  return Object.fromEntries(keys.map((key) => [text(key, 128), json(input[key], depth + 1)]));
}
export function markParsedContract(value: object): void {
  parsedContracts.add(value);
}
export function isParsedContract(value: object): boolean {
  return parsedContracts.has(value);
}
