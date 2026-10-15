import { parseBoundedStrictJson } from "./strict-json.js";

/** Up to one bounded SB page, including project arrays; independent of personal MCP limits. */
export function parseCompanyJson(text: string): unknown | undefined {
  const limits = { depth: 16, nodes: 65_536, workItems: 262_144, characters: 1_048_576 };
  const value = parseBoundedStrictJson(text, limits);
  const v2 = v2Object(value) || (typeof value === "object" && value !== null && "handoffs" in value
    && Array.isArray(value.handoffs) && value.handoffs.some((item: unknown) =>
      typeof item === "object" && item !== null && "command" in item && v2Object(item.command)));
  return v2 ? parseBoundedStrictJson(text, { ...limits, companyV2Profile: true }) : value;
}

function v2Object(value: unknown): boolean {
  return typeof value === "object" && value !== null
    && (("schema_version" in value && value.schema_version === 2)
      || ("request_id" in value && typeof value.request_id === "string" && value.request_id.startsWith("company-handoff:v2:")));
}

export function parseCompanyJsonBytes(bytes: Uint8Array): unknown | undefined {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return undefined;
  try {
    return parseCompanyJson(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (error) {
    if (error instanceof TypeError) return undefined;
    throw error;
  }
}
