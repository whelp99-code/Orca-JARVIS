import { types as utilTypes } from "node:util";

const DESCRIPTION_BYTES = 8_192;
const OUTPUT_SCHEMAS = {
  sb_search: { additionalProperties: true, type: "object" },
  sb_read_page: { additionalProperties: true, type: "object" },
  sb_recent_changes: { additionalProperties: true, type: "object" },
  sb_open_conflicts: { additionalProperties: true, type: "object" },
  sb_remember: { additionalProperties: { type: "string" }, type: "object" },
  sb_generation_status: { additionalProperties: true, type: "object" },
  sb_request_status: { additionalProperties: true, type: "object" },
  sb_submit_cancellation: { additionalProperties: true, type: "object" },
  sb_cancellation_status: { additionalProperties: true, type: "object" },
  sb_resolve_memory_target: { additionalProperties: true, type: "object" },
} as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function titleValid(value: Record<string, unknown>): boolean {
  return !Object.hasOwn(value, "title") || (typeof value.title === "string"
    && Buffer.byteLength(value.title, "utf8") <= DESCRIPTION_BYTES);
}
function titlesValid(value: unknown): boolean {
  if (Array.isArray(value)) return value.every(titlesValid);
  if (!isRecord(value)) return true;
  return titleValid(value)
    && Object.entries(value).every(([key, item]) => key === "title" || titlesValid(item));
}
type ArgumentSnapshot = { readonly ok: true; readonly value: unknown } | { readonly ok: false };
function safeArgumentSnapshot(value: unknown, depth = 0): ArgumentSnapshot {
  if (depth > 8 || utilTypes.isProxy(value)) return { ok: false };
  if (value === null || typeof value === "string" || typeof value === "boolean"
    || (typeof value === "number" && Number.isFinite(value) && Number.isSafeInteger(value))) {
    return { ok: true, value };
  }
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype || Reflect.ownKeys(value).length !== value.length + 1) return { ok: false };
    const result: unknown[] = [];
    for (const item of value) { const child = safeArgumentSnapshot(item, depth + 1); if (!child.ok) return child; result.push(child.value); }
    return { ok: true, value: Object.freeze(result) };
  }
  if (!isRecord(value) || Object.getPrototypeOf(value) !== Object.prototype) return { ok: false };
  const result: Record<string, unknown> = {};
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || key === "toJSON") return { ok: false };
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) return { ok: false };
    const child = safeArgumentSnapshot(descriptor.value, depth + 1); if (!child.ok) return child;
    result[key] = child.value;
  }
  return { ok: true, value: Object.freeze(result) };
}

export function snapshotArguments(value: unknown): Readonly<Record<string, unknown>> | undefined {
  try {
    if (utilTypes.isProxy(value) || !isRecord(value)
      || Object.getPrototypeOf(value) !== Object.prototype) return undefined;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const snapshot: Record<string, unknown> = {};
    for (const key of Reflect.ownKeys(descriptors)) {
      if (typeof key !== "string" || key === "toJSON") return undefined;
      const descriptor = descriptors[key];
      if (!descriptor || !descriptor.enumerable || !("value" in descriptor)
        || descriptor.get !== undefined || descriptor.set !== undefined) return undefined;
      const child = safeArgumentSnapshot(descriptor.value, 1); if (!child.ok) return undefined;
      snapshot[key] = child.value;
    }
    return Object.freeze(snapshot);
  } catch {
    return undefined;
  }
}

const JSON_VALUE_DEFS = { JsonValue: { anyOf: [
  { type: "boolean" }, { type: "integer" }, { type: "number" }, { type: "string" },
  { items: { $ref: "#/$defs/JsonValue" }, type: "array" },
  { additionalProperties: { $ref: "#/$defs/JsonValue" }, type: "object" }, { type: "null" },
] } } as const;
function normalizedType(value: Record<string, unknown>): readonly string[] | undefined {
  if (typeof value.type === "string") return [value.type];
  if (Array.isArray(value.type) && value.type.every(item => typeof item === "string")) {
    return [...value.type].sort();
  }
  if (!Array.isArray(value.anyOf) || value.anyOf.length !== 2) return undefined;
  const types: string[] = [];
  for (const item of value.anyOf) {
    if (!isRecord(item) || !titleValid(item) || typeof item.type !== "string") return undefined;
    const keys = Object.keys(item);
    const simple = keys.every(key => key === "type" || key === "title");
    const recursiveObject = item.type === "object" && keys.every(key => ["type", "title", "additionalProperties"].includes(key))
      && isRecord(item.additionalProperties) && item.additionalProperties.$ref === "#/$defs/JsonValue"
      && Object.keys(item.additionalProperties).length === 1;
    const recursiveArray = item.type === "array" && keys.every(key => ["type", "title", "items"].includes(key))
      && isRecord(item.items) && item.items.$ref === "#/$defs/JsonValue" && Object.keys(item.items).length === 1;
    if (!simple && !recursiveObject && !recursiveArray) return undefined;
    types.push(item.type);
  }
  return types.sort();
}
function propertyMatches(observed: unknown, expected: unknown): boolean {
  if (!isRecord(observed) || !isRecord(expected) || !titleValid(observed)
    || !Object.keys(observed).every(key => ["type", "anyOf", "default", "title"].includes(key))) {
    return false;
  }
  const left = normalizedType(observed); const right = normalizedType(expected);
  if (!left || !right || left.join("\0") !== right.join("\0")) return false;
  return ("default" in observed) === ("default" in expected)
    && (!("default" in expected) || Object.is(observed.default, expected.default));
}
function inputSchemaMatches(observed: unknown, expected: unknown): boolean {
  if (!isRecord(observed) || !isRecord(expected) || !titleValid(observed)
    || observed.type !== "object" || expected.type !== "object"
    || !isRecord(observed.properties) || !isRecord(expected.properties)) return false;
  const left = observed.properties; const right = expected.properties;
  const allowed = ["$defs", "type", "properties", "required", "additionalProperties", "title"];
  if (!Object.keys(observed).every(key => allowed.includes(key))
     || (observed.$defs !== undefined && canonical(observed.$defs) !== canonical(JSON_VALUE_DEFS))
    || (observed.additionalProperties !== undefined && observed.additionalProperties !== false)) {
    return false;
  }
  const observedRequired = observed.required === undefined ? [] : observed.required;
  const expectedRequired = expected.required;
  if (!Array.isArray(observedRequired) || !Array.isArray(expectedRequired)
    || observedRequired.join("\0") !== expectedRequired.join("\0")
    || Object.keys(left).sort().join("\0") !== Object.keys(right).sort().join("\0")) return false;
  return Object.keys(right).every(name => propertyMatches(left[name], right[name]));
}
function withoutTitles(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutTitles);
  if (!isRecord(value)) return value;
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    if (key !== "title") result[key] = withoutTitles(value[key]);
  }
  return result;
}
function canonical(value: unknown): string { return JSON.stringify(withoutTitles(value)); }
function writeInputCanonical(value: unknown, schema5 = false): string {
  const normalized = withoutTitles(value);
  if (isRecord(normalized) && (normalized.additionalProperties === false
    || normalized.additionalProperties === undefined)) delete normalized.additionalProperties;
  if (isRecord(normalized) && isRecord(normalized.$defs)) {
    const alias = schema5 ? "MemoryRememberWriteRequest" : "MemoryWriteRequest";
    const union = normalized.$defs[alias];
    if (isRecord(union) && isRecord(normalized.properties)
      && (!schema5 || canonical(normalized.properties.request) === canonical({ $ref: `#/$defs/${alias}` }))) {
      const discriminator = union["discriminator"];
      if (isRecord(discriminator) && canonical(discriminator["mapping"]) === canonical({
        "1": "#/$defs/MemoryWriteRequestModel", "2": "#/$defs/MemoryEffectWriteRequestV2",
        ...(schema5 ? { "3": "#/$defs/MemoryRememberRequestV3Model" } : {}),
      })) delete discriminator["mapping"];
      normalized.properties["request"] = union;
      delete normalized.$defs[alias];
    }
    if (!schema5) delete normalized.$defs["MemoryWriteRequestModel"];
  }
  return JSON.stringify(normalized);
}
function cancellationInputCanonical(value: unknown): string {
  if (!titlesValid(value)) return "invalid";
  const normalized = withoutTitles(value);
  if (isRecord(normalized) && normalized.additionalProperties === false) delete normalized.additionalProperties;
  return JSON.stringify(normalized);
}
function outputSchema(name: string, tool: Record<string, unknown>): unknown {
  switch (name) {
    case "sb_search": return OUTPUT_SCHEMAS.sb_search;
    case "sb_read_page": return OUTPUT_SCHEMAS.sb_read_page;
    case "sb_recent_changes": return OUTPUT_SCHEMAS.sb_recent_changes;
    case "sb_open_conflicts": return OUTPUT_SCHEMAS.sb_open_conflicts;
    case "sb_remember": return OUTPUT_SCHEMAS.sb_remember;
    case "sb_generation_status": return OUTPUT_SCHEMAS.sb_generation_status;
    case "sb_request_status": return OUTPUT_SCHEMAS.sb_request_status;
    case "sb_submit_cancellation": return OUTPUT_SCHEMAS.sb_submit_cancellation;
    case "sb_cancellation_status": return OUTPUT_SCHEMAS.sb_cancellation_status;
    case "sb_resolve_memory_target": return OUTPUT_SCHEMAS.sb_resolve_memory_target;
    case "sb_write_request": return tool["output_schema"];
    default: return undefined;
  }
}

type SchemaInspection = {
  readonly matches: boolean;
  readonly requiresLocalArguments: boolean;
};
function mismatch(): SchemaInspection {
  return { matches: false, requiresLocalArguments: false };
}
export function inspectFrozenSchemas(observed: unknown, contract: unknown): SchemaInspection {
  if (!Array.isArray(observed) || !isRecord(contract) || !isRecord(contract.tools)
    || observed.length !== Object.keys(contract.tools).length) return mismatch();
  const names = new Set<string>(); let requiresLocalArguments = false;
  for (const value of observed) {
    if (!isRecord(value) || typeof value.name !== "string" || names.has(value.name)) return mismatch();
    const keys = Object.keys(value).sort().join("\0");
    const producer = keys === "description\0inputSchema\0name\0outputSchema";
    if (keys !== "inputSchema\0name" && (!producer || typeof value.description !== "string"
      || Buffer.byteLength(value.description, "utf8") > DESCRIPTION_BYTES)) return mismatch();
    const tool = contract.tools[value.name]; if (!isRecord(tool)) return mismatch();
    const inputMatches = (contract.profile === "scoped-record-read-v1" || contract.profile === "scoped-record-read-v2")
      ? cancellationInputCanonical(value.inputSchema) === cancellationInputCanonical(tool.arguments)
      : value.name === "sb_write_request"
      ? writeInputCanonical(value.inputSchema, contract.schema_version === 5 || contract.schema_version === 6 || contract.schema_version === 7)
        === writeInputCanonical(tool.arguments, contract.schema_version === 5 || contract.schema_version === 6 || contract.schema_version === 7)
      : value.name === "sb_submit_cancellation"
        ? cancellationInputCanonical(value.inputSchema) === cancellationInputCanonical(tool.arguments)
        : inputSchemaMatches(value.inputSchema, tool.arguments);
    if (!inputMatches) return mismatch();
    const expectedOutput = outputSchema(value.name, tool);
    if (producer && (!titlesValid(value.outputSchema)
      || (expectedOutput !== undefined && canonical(value.outputSchema) !== canonical(expectedOutput)))) return mismatch();
    if (value.name !== "sb_write_request" && isRecord(value.inputSchema)
      && value.inputSchema.additionalProperties === undefined) requiresLocalArguments = true;
    names.add(value.name);
  }
  return { matches: names.size === Object.keys(contract.tools).length, requiresLocalArguments };
}
function validType(value: unknown, types: readonly string[]): boolean {
  return types.some(type => {
    switch (type) {
      case "null": return value === null;
      case "string": return typeof value === "string";
      case "integer": return typeof value === "number" && Number.isSafeInteger(value);
      case "number": return typeof value === "number" && Number.isFinite(value);
      case "boolean": return typeof value === "boolean";
      case "object": return isRecord(value) && Object.getPrototypeOf(value) === Object.prototype;
      case "array": return Array.isArray(value) && Object.getPrototypeOf(value) === Array.prototype;
      default: return false;
    }
  });
}
export function frozenArgumentsMatch(
  method: string,
  arguments_: unknown,
  contract: unknown,
): boolean {
  if (!isRecord(arguments_) || !isRecord(contract) || !isRecord(contract.tools)) return false;
  const tool = contract.tools[method];
  if (!isRecord(tool) || !isRecord(tool.arguments) || !isRecord(tool.arguments.properties)
    || !Array.isArray(tool.arguments.required)) return false;
  const properties = tool.arguments.properties;
  if (Object.keys(arguments_).some(name => !Object.hasOwn(properties, name))) return false;
  if (!tool.arguments.required.every(
    name => typeof name === "string" && Object.hasOwn(arguments_, name),
  )) return false;
  return Object.entries(arguments_).every(([name, value]) => {
    const schema = properties[name];
    return isRecord(schema) && validType(value, normalizedType(schema) ?? []);
  });
}
