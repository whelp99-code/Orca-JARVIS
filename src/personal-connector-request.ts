import { PERSONAL_CONNECTOR_IDS, PersonalConnectorError, type PersonalConnectorId, type PersonalConnectorReadRequest } from "./personal-connector-types.js";

const MAX_ITEMS = 32;
const MAX_TEXT = 256;
const UUID_PATTERN = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const CHECKPOINT_PATTERN = new RegExp(`^pcp:1:${UUID_PATTERN}:${UUID_PATTERN}$`, "u");

function fail(): never { throw new PersonalConnectorError("PERSONAL_CONNECTOR_REQUEST_INVALID"); }

function connectorId(value: unknown): PersonalConnectorId {
  if (typeof value !== "string") return fail();
  for (const id of PERSONAL_CONNECTOR_IDS) if (id === value) return id;
  throw new PersonalConnectorError("PERSONAL_CONNECTOR_UNKNOWN");
}

function denseStrings(value: unknown): readonly string[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > MAX_ITEMS) return fail();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable
      || typeof descriptor.value !== "string" || descriptor.value.length < 1 || descriptor.value.length > MAX_TEXT) return fail();
  }
  if (Object.keys(value).length !== value.length) return fail();
  if (new Set(value).size !== value.length) return fail();
  return Object.freeze([...value]);
}

export function parsePersonalConnectorRequest(value: unknown): PersonalConnectorReadRequest {
  try {
    if (typeof value !== "object" || value === null || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return fail();
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Object.keys(descriptors).sort();
    const required = ["connector_id", "fields", "scopes"];
    const expected = descriptors["checkpoint"] === undefined ? required : [...required, "checkpoint"].sort();
    if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) return fail();
    for (const descriptor of Object.values(descriptors)) {
      if (!("value" in descriptor) || !descriptor.enumerable) return fail();
    }
    const id = connectorId(descriptors["connector_id"]?.value);
    const scopes = denseStrings(descriptors["scopes"]?.value);
    const fields = denseStrings(descriptors["fields"]?.value);
    const checkpoint = descriptors["checkpoint"]?.value;
    if (checkpoint !== undefined && (typeof checkpoint !== "string" || !CHECKPOINT_PATTERN.test(checkpoint))) return fail();
    return checkpoint === undefined ? { connector_id: id, scopes, fields } : { connector_id: id, scopes, fields, checkpoint };
  } catch (error) {
    if (error instanceof PersonalConnectorError) throw error;
    return fail();
  }
}

export function readPersonalClock(clock: () => Date): Date | undefined {
  try {
    const value = clock();
    return value instanceof Date && Number.isFinite(value.getTime()) && value.toISOString() === value.toISOString()
      ? new Date(value.getTime())
      : undefined;
  } catch {
    return undefined;
  }
}
