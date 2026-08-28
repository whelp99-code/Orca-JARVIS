export type FrozenArgumentSchema = Readonly<Record<string, unknown>>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizedType(value: Record<string, unknown>): readonly string[] | undefined {
  if (typeof value.type === "string") return [value.type];
  if (Array.isArray(value.type) && value.type.every(item => typeof item === "string")) return [...value.type].sort();
  if (!Array.isArray(value.anyOf) || value.anyOf.length !== 2) return undefined;
  const types = value.anyOf.map(item => isRecord(item) && Object.keys(item).every(key => key === "type" || key === "title") ? item.type : undefined);
  return types.every(item => typeof item === "string") ? (types as string[]).sort() : undefined;
}

function propertyMatches(observed: unknown, expected: unknown): boolean {
  if (!isRecord(observed) || !isRecord(expected)) return false;
  if (!Object.keys(observed).every(key => ["type", "anyOf", "default", "title"].includes(key))) return false;
  const observedTypes = normalizedType(observed); const expectedTypes = normalizedType(expected);
  if (!observedTypes || !expectedTypes || observedTypes.join("\0") !== expectedTypes.join("\0")) return false;
  return ("default" in observed) === ("default" in expected) && (!("default" in expected) || Object.is(observed.default, expected.default));
}

function schemaMatches(observed: unknown, expected: unknown): boolean {
  if (!isRecord(observed) || !isRecord(expected) || observed.type !== "object" || expected.type !== "object" || !isRecord(observed.properties) || !isRecord(expected.properties)) return false;
  const observedProperties = observed.properties; const expectedProperties = expected.properties;
  if (!Object.keys(observed).every(key => ["type", "properties", "required", "additionalProperties", "title"].includes(key))) return false;
  if (observed.additionalProperties !== undefined && observed.additionalProperties !== false) return false;
  const observedRequired = observed.required === undefined ? [] : observed.required; const expectedRequired = expected.required;
  if (!Array.isArray(observedRequired) || !Array.isArray(expectedRequired) || observedRequired.join("\0") !== expectedRequired.join("\0")) return false;
  if (Object.keys(observedProperties).sort().join("\0") !== Object.keys(expectedProperties).sort().join("\0")) return false;
  return Object.keys(expectedProperties).every(name => propertyMatches(observedProperties[name], expectedProperties[name]));
}

export function inspectFrozenSchemas(observed: unknown, contract: unknown): { readonly matches: boolean; readonly requiresLocalArguments: boolean } {
  if (!Array.isArray(observed) || !isRecord(contract) || !isRecord(contract.tools) || observed.length !== Object.keys(contract.tools).length) return { matches: false, requiresLocalArguments: false };
  const names = new Set<string>(); let requiresLocalArguments = false;
  for (const value of observed) {
    if (!isRecord(value) || typeof value.name !== "string" || names.has(value.name)) return { matches: false, requiresLocalArguments: false };
    const keys = Object.keys(value).sort().join("\0"); const producerMetadata = keys === "description\0inputSchema\0name\0outputSchema" && typeof value.description === "string" && isRecord(value.outputSchema); if (keys !== "inputSchema\0name" && !producerMetadata) return { matches: false, requiresLocalArguments: false };
    const tool = contract.tools[value.name]; if (!isRecord(tool) || !schemaMatches(value.inputSchema, tool.arguments)) return { matches: false, requiresLocalArguments: false };
    if (isRecord(value.inputSchema) && value.inputSchema.additionalProperties === undefined) requiresLocalArguments = true; names.add(value.name);
  }
  return { matches: names.size === Object.keys(contract.tools).length, requiresLocalArguments };
}

function validType(value: unknown, types: readonly string[]): boolean {
  return types.some(type => type === "null" ? value === null : type === "string" ? typeof value === "string" : type === "integer" ? typeof value === "number" && Number.isSafeInteger(value) : type === "number" ? typeof value === "number" && Number.isFinite(value) : type === "boolean" ? typeof value === "boolean" : false);
}

export function frozenArgumentsMatch(method: string, arguments_: unknown, contract: unknown): boolean {
  if (!isRecord(arguments_) || !isRecord(contract) || !isRecord(contract.tools)) return false;
  const tool = contract.tools[method]; if (!isRecord(tool) || !isRecord(tool.arguments) || !isRecord(tool.arguments.properties) || !Array.isArray(tool.arguments.required)) return false;
  const properties = tool.arguments.properties; if (Object.keys(arguments_).some(name => !(name in properties))) return false;
  if (!tool.arguments.required.every(name => typeof name === "string" && name in arguments_)) return false;
  return Object.entries(arguments_).every(([name, value]) => { const schema = properties[name]; return isRecord(schema) && (normalizedType(schema)?.some(() => true) ?? false) && validType(value, normalizedType(schema) ?? []); });
}
