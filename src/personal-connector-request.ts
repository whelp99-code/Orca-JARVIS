import {
  PERSONAL_CONNECTOR_IDS,
  PersonalConnectorError,
  type PersonalCheckpointSessionRequest,
  type PersonalConnectorId,
  type PersonalConnectorReadRequest,
} from "./personal-connector-types.js";

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
  if (Object.keys(value).length !== value.length || new Set(value).size !== value.length) return fail();
  return Object.freeze([...value]);
}
function session(value: unknown): PersonalCheckpointSessionRequest {
  if (typeof value !== "object" || value === null || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype) return fail();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const mode = descriptors["mode"]?.value;
  const keys = Object.keys(descriptors).sort();
  const expected = mode === "start" ? ["mode", "version"] : ["handle", "mode", "version"];
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) return fail();
  for (const descriptor of Object.values(descriptors)) if (!("value" in descriptor) || !descriptor.enumerable) return fail();
  if (descriptors["version"]?.value !== 1) return fail();
  if (mode === "start") return Object.freeze({ mode: "start", version: 1 });
  const handle = descriptors["handle"]?.value;
  if (mode !== "continue" || typeof handle !== "string" || !CHECKPOINT_PATTERN.test(handle)) return fail();
  return Object.freeze({ mode: "continue", version: 1, handle });
}

export function parsePersonalConnectorRequest(value: unknown): PersonalConnectorReadRequest {
  try {
    if (typeof value !== "object" || value === null || Array.isArray(value)
      || Object.getPrototypeOf(value) !== Object.prototype) return fail();
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Object.keys(descriptors).sort();
    const required = ["connector_id", "fields", "scopes"];
    const expected = descriptors["checkpoint_session"] === undefined ? required : [...required, "checkpoint_session"].sort();
    if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) return fail();
    for (const descriptor of Object.values(descriptors)) if (!("value" in descriptor) || !descriptor.enumerable) return fail();
    const request = {
      connector_id: connectorId(descriptors["connector_id"]?.value),
      scopes: denseStrings(descriptors["scopes"]?.value),
      fields: denseStrings(descriptors["fields"]?.value),
    };
    const checkpointSession = descriptors["checkpoint_session"]?.value;
    return checkpointSession === undefined ? Object.freeze(request) : Object.freeze({
      ...request, checkpoint_session: session(checkpointSession),
    });
  } catch (error) {
    if (error instanceof PersonalConnectorError) throw error;
    return fail();
  }
}

export function readPersonalClock(clock: () => Date): Date | undefined {
  try {
    const value = clock();
    return value instanceof Date && Number.isFinite(value.getTime()) && value.toISOString() === value.toISOString()
      ? new Date(value.getTime()) : undefined;
  } catch { return undefined; }
}
