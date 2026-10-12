import { parseBoundedStrictJson } from "./strict-json.js";

/** Up to one bounded SB page, including project arrays; independent of personal MCP limits. */
export function parseCompanyJson(text: string): unknown | undefined {
  return parseBoundedStrictJson(text, {
    depth: 16, nodes: 65_536, workItems: 262_144, characters: 1_048_576,
  });
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
