import { types as utilTypes } from "node:util";

const DESCRIPTION_BYTES = 8_192;
const OUTPUT_SCHEMAS = {
  sb_search: { $defs: { SearchHitDict: { properties: { page_id: { type: "string" }, section: { type: "string" }, snippet: { type: "string" }, score: { type: "number" } }, required: ["page_id", "section", "snippet", "score"], type: "object" } }, additionalProperties: { items: { $ref: "#/$defs/SearchHitDict" }, type: "array" }, type: "object" },
  sb_read_page: { additionalProperties: { anyOf: [{ additionalProperties: { type: "string" }, type: "object" }, { type: "string" }] }, type: "object" },
  sb_recent_changes: { additionalProperties: { items: { additionalProperties: { type: "string" }, type: "object" }, type: "array" }, type: "object" },
  sb_open_conflicts: { additionalProperties: { items: { additionalProperties: { type: "string" }, type: "object" }, type: "array" }, type: "object" },
  sb_remember: { additionalProperties: { type: "string" }, type: "object" },
} as const;

function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function titleValid(value: Record<string, unknown>): boolean { return !Object.hasOwn(value, "title") || (typeof value.title === "string" && Buffer.byteLength(value.title, "utf8") <= DESCRIPTION_BYTES); }
function titlesValid(value: unknown): boolean { if (Array.isArray(value)) return value.every(titlesValid); if (!isRecord(value)) return true; return titleValid(value) && Object.entries(value).every(([key, item]) => key === "title" || titlesValid(item)); }

function safeArgumentValue(value: unknown): boolean { return value === null || typeof value === "string" || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value) && Number.isSafeInteger(value)); }
export function snapshotArguments(value: unknown): Readonly<Record<string, unknown>> | undefined {
  try {
    if (utilTypes.isProxy(value) || !isRecord(value) || Object.getPrototypeOf(value) !== Object.prototype) return undefined;
    const descriptors = Object.getOwnPropertyDescriptors(value); const snapshot: Record<string, unknown> = {};
    for (const key of Reflect.ownKeys(descriptors)) {
      if (typeof key !== "string" || key === "toJSON") return undefined; const descriptor = descriptors[key];
      if (!descriptor || !descriptor.enumerable || !("value" in descriptor) || descriptor.get !== undefined || descriptor.set !== undefined || !safeArgumentValue(descriptor.value)) return undefined;
      snapshot[key] = descriptor.value;
    }
    return Object.freeze(snapshot);
  } catch { return undefined; }
}

function normalizedType(value: Record<string, unknown>): readonly string[] | undefined {
  if (typeof value.type === "string") return [value.type];
  if (Array.isArray(value.type) && value.type.every(item => typeof item === "string")) return [...value.type].sort();
  if (!Array.isArray(value.anyOf) || value.anyOf.length !== 2) return undefined; const types: string[] = [];
  for (const item of value.anyOf) { if (!isRecord(item) || !titleValid(item) || !Object.keys(item).every(key => key === "type" || key === "title") || typeof item.type !== "string") return undefined; types.push(item.type); }
  return types.sort();
}

function propertyMatches(observed: unknown, expected: unknown): boolean {
  if (!isRecord(observed) || !isRecord(expected) || !titleValid(observed) || !Object.keys(observed).every(key => ["type", "anyOf", "default", "title"].includes(key))) return false;
  const left = normalizedType(observed); const right = normalizedType(expected); if (!left || !right || left.join("\0") !== right.join("\0")) return false;
  return ("default" in observed) === ("default" in expected) && (!("default" in expected) || Object.is(observed.default, expected.default));
}

function inputSchemaMatches(observed: unknown, expected: unknown): boolean {
  if (!isRecord(observed) || !isRecord(expected) || !titleValid(observed) || observed.type !== "object" || expected.type !== "object" || !isRecord(observed.properties) || !isRecord(expected.properties)) return false;
  const left = observed.properties; const right = expected.properties;
  if (!Object.keys(observed).every(key => ["type", "properties", "required", "additionalProperties", "title"].includes(key)) || (observed.additionalProperties !== undefined && observed.additionalProperties !== false)) return false;
  const observedRequired = observed.required === undefined ? [] : observed.required; const expectedRequired = expected.required;
  if (!Array.isArray(observedRequired) || !Array.isArray(expectedRequired) || observedRequired.join("\0") !== expectedRequired.join("\0") || Object.keys(left).sort().join("\0") !== Object.keys(right).sort().join("\0")) return false;
  return Object.keys(right).every(name => propertyMatches(left[name], right[name]));
}

function withoutTitles(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutTitles);
  if (!isRecord(value)) return value; const result: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) if (key !== "title") result[key] = withoutTitles(value[key]);
  return result;
}
function canonical(value: unknown): string { return JSON.stringify(withoutTitles(value)); }
function writeInputCanonical(value: unknown): string {
  const normalized = withoutTitles(value);
  if (isRecord(normalized) && isRecord(normalized.$defs)) delete normalized.$defs["MemoryWriteRequestModel"];
  return JSON.stringify(normalized);
}
function outputSchema(name: string, tool: Record<string, unknown>): unknown {
  switch (name) {
    case "sb_search": return OUTPUT_SCHEMAS.sb_search;
    case "sb_read_page": return OUTPUT_SCHEMAS.sb_read_page;
    case "sb_recent_changes": return OUTPUT_SCHEMAS.sb_recent_changes;
    case "sb_open_conflicts": return OUTPUT_SCHEMAS.sb_open_conflicts;
    case "sb_remember": return OUTPUT_SCHEMAS.sb_remember;
    case "sb_write_request": return tool["output_schema"];
    default: return undefined;
  }
}

export function inspectFrozenSchemas(observed: unknown, contract: unknown): { readonly matches: boolean; readonly requiresLocalArguments: boolean } {
  if (!Array.isArray(observed) || !isRecord(contract) || !isRecord(contract.tools) || observed.length !== Object.keys(contract.tools).length) return { matches: false, requiresLocalArguments: false };
  const names = new Set<string>(); let requiresLocalArguments = false;
  for (const value of observed) {
    if (!isRecord(value) || typeof value.name !== "string" || names.has(value.name)) return { matches: false, requiresLocalArguments: false };
    const keys = Object.keys(value).sort().join("\0"); const producer = keys === "description\0inputSchema\0name\0outputSchema";
    if (keys !== "inputSchema\0name" && (!producer || typeof value.description !== "string" || Buffer.byteLength(value.description, "utf8") > DESCRIPTION_BYTES)) return { matches: false, requiresLocalArguments: false };
    const tool = contract.tools[value.name]; if (!isRecord(tool)) return { matches: false, requiresLocalArguments: false };
    const inputMatches = value.name === "sb_write_request" ? writeInputCanonical(value.inputSchema) === writeInputCanonical(tool.arguments) : inputSchemaMatches(value.inputSchema, tool.arguments);
    if (!inputMatches) return { matches: false, requiresLocalArguments: false };
    if (producer && (!titlesValid(value.outputSchema) || canonical(value.outputSchema) !== canonical(outputSchema(value.name, tool)))) return { matches: false, requiresLocalArguments: false };
    if (value.name !== "sb_write_request" && isRecord(value.inputSchema) && value.inputSchema.additionalProperties === undefined) requiresLocalArguments = true; names.add(value.name);
  }
  return { matches: names.size === Object.keys(contract.tools).length, requiresLocalArguments };
}

function validType(value: unknown, types: readonly string[]): boolean { return types.some(type => type === "null" ? value === null : type === "string" ? typeof value === "string" : type === "integer" ? typeof value === "number" && Number.isSafeInteger(value) : type === "number" ? typeof value === "number" && Number.isFinite(value) : type === "boolean" ? typeof value === "boolean" : false); }
export function frozenArgumentsMatch(method: string, arguments_: unknown, contract: unknown): boolean {
  if (!isRecord(arguments_) || !isRecord(contract) || !isRecord(contract.tools)) return false;
  const tool = contract.tools[method]; if (!isRecord(tool) || !isRecord(tool.arguments) || !isRecord(tool.arguments.properties) || !Array.isArray(tool.arguments.required)) return false;
  const properties = tool.arguments.properties; if (Object.keys(arguments_).some(name => !Object.hasOwn(properties, name))) return false;
  if (!tool.arguments.required.every(name => typeof name === "string" && Object.hasOwn(arguments_, name))) return false;
  return Object.entries(arguments_).every(([name, value]) => { const schema = properties[name]; return isRecord(schema) && validType(value, normalizedType(schema) ?? []); });
}
