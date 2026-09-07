import { parseBoundedStrictJson } from "./strict-json.js";

export const SECOND_BRAIN_STRICT_JSON_MAX_DEPTH = 64;
export const SECOND_BRAIN_STRICT_JSON_MAX_NODES = 4_096;
export const SECOND_BRAIN_STRICT_JSON_MAX_WORK_ITEMS = 16_384;
export const SECOND_BRAIN_STRICT_JSON_MAX_CHARACTERS = 1_048_576;

export function parseSecondBrainStrictJson(text: string): unknown | undefined {
  return parseBoundedStrictJson(text, {
    depth: SECOND_BRAIN_STRICT_JSON_MAX_DEPTH,
    nodes: SECOND_BRAIN_STRICT_JSON_MAX_NODES,
    workItems: SECOND_BRAIN_STRICT_JSON_MAX_WORK_ITEMS,
    characters: SECOND_BRAIN_STRICT_JSON_MAX_CHARACTERS,
  });
}

export function parseSecondBrainStrictJsonBytes(bytes: Uint8Array): unknown | undefined {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return undefined;
  try {
    return parseSecondBrainStrictJson(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (error) {
    if (error instanceof TypeError) return undefined;
    throw error;
  }
}
