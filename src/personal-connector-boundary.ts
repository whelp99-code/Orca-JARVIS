import type { PersonalConnectorValue, PersonalSourceSnapshot } from "./personal-connector-types.js";

const SNAPSHOT_KEYS = [
  "cursor", "evidence_refs", "incarnation", "observed_at", "schema_version", "sequence", "source_version", "status", "values",
] as const;
const STATUSES = ["current", "no_data", "stale", "offline", "unavailable"] as const;
const MAX_STRING_BYTES = 512;
const MAX_ARRAY_ITEMS = 32;
const MAX_RECORD_KEYS = 32;
const PROHIBITED_VALUE = /(?:-----BEGIN |\bxox[baprs]-|\bsk-[A-Za-z0-9_-]{8,}|\/(?:home|Users|Volumes)\/)/u;

function ownPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  try {
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return false;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    return Object.values(descriptors).every(descriptor => "value" in descriptor);
  } catch {
    return false;
  }
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  let actual: readonly string[];
  try {
    actual = Object.keys(value).sort();
  } catch {
    return false;
  }
  const sorted = [...expected].sort();
  return actual.length === sorted.length && actual.every((key, index) => key === sorted[index]);
}

function boundedString(value: unknown, allowEmpty = false): value is string {
  return typeof value === "string" && (allowEmpty || value.length > 0) && value === value.normalize("NFC")
    && Buffer.byteLength(value, "utf8") <= MAX_STRING_BYTES && !PROHIBITED_VALUE.test(value);
}

function instant(value: unknown): value is string {
  if (!boundedString(value) || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u.test(value)) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function stringArray(value: unknown): value is readonly string[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > MAX_ARRAY_ITEMS) return false;
  return value.every(item => boundedString(item));
}

function connectorValue(value: unknown): value is PersonalConnectorValue {
  if (value === null || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isSafeInteger(value) && value >= 0;
  return boundedString(value, true) || stringArray(value);
}

function valuesRecord(value: unknown, allowedFields: readonly string[]): value is Readonly<Record<string, PersonalConnectorValue>> {
  if (!ownPlainRecord(value)) return false;
  let entries: readonly [string, unknown][];
  try {
    entries = Object.entries(value);
  } catch {
    return false;
  }
  return entries.length <= MAX_RECORD_KEYS
    && entries.every(([key, child]) => allowedFields.includes(key) && connectorValue(child));
}

function status(value: unknown): value is PersonalSourceSnapshot["status"] {
  return STATUSES.some(candidate => candidate === value);
}

export function parsePersonalSourceSnapshot(value: unknown, allowedFields: readonly string[]): PersonalSourceSnapshot | undefined {
  if (!ownPlainRecord(value) || !exactKeys(value, SNAPSHOT_KEYS)) return undefined;
  if (value["schema_version"] !== 1 || !boundedString(value["source_version"]) || !boundedString(value["cursor"])
    || (value["incarnation"] !== null && !boundedString(value["incarnation"]))
    || typeof value["sequence"] !== "number" || !Number.isSafeInteger(value["sequence"]) || value["sequence"] < 0
    || !instant(value["observed_at"]) || !status(value["status"]) || !stringArray(value["evidence_refs"])
    || !valuesRecord(value["values"], allowedFields)) return undefined;
  if (value["status"] === "no_data" && Object.keys(value["values"]).length !== 0) return undefined;
  return {
    schema_version: 1,
    source_version: value["source_version"], incarnation: value["incarnation"], sequence: value["sequence"],
    cursor: value["cursor"], observed_at: value["observed_at"], status: value["status"],
    evidence_refs: [...value["evidence_refs"]], values: { ...value["values"] },
  };
}
