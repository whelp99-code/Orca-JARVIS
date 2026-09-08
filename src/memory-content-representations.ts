import { isUtf8 } from "node:buffer";
import { createHash } from "node:crypto";
import { JarvisError } from "./db.js";

const MAX_MATERIAL_ITEMS = 100_000;
const MAX_MATERIAL_BYTES = 64 * 1024 * 1024;
const HEX = Buffer.from("0123456789abcdef", "ascii");

/** Synchronous use only. Generated buffers are wiped on success and failure.
 * Raw + two JSON string interiors; not arbitrary serializers or page layouts.
 * The byte budget includes input and both generated levels, before allocation.
 */
export function withMemoryContentRepresentations<T>(
  material: readonly Buffer[], consume: (values: readonly Buffer[]) => T,
): T {
  let bytes = 0;
  const reserve = (size: number): void => {
    bytes += size;
    if (bytes > MAX_MATERIAL_BYTES) throw new JarvisError("MEMORY_CONTENT_REPRESENTATION_LIMIT");
  };
  if (material.length > MAX_MATERIAL_ITEMS) throw new JarvisError("MEMORY_CONTENT_REPRESENTATION_LIMIT");
  for (const value of material) reserve(value.byteLength);
  const values = new Map<string, Buffer>();
  const owned: Buffer[] = [];
  const add = (value: Buffer): void => {
    const key = createHash("sha256").update(value).digest("hex");
    if (!values.has(key)) values.set(key, value);
  };
  try {
    for (const value of material) {
      if (value.byteLength === 0) continue;
      add(value);
      // Do not turn malformed bytes into replacement-character fingerprints.
      if (!isUtf8(value)) continue;
      let current = value;
      for (let depth = 0; depth < 2; depth += 1) {
        let size = 0;
        for (const byte of current) size += escapedByteLength(byte);
        if (size === current.byteLength) break;
        reserve(size);
        const escaped = Buffer.alloc(size);
        owned.push(escaped);
        escapeJsonBytes(current, escaped);
        add(escaped);
        current = escaped;
      }
    }
    const result = consume([...values.values()]);
    if (result !== null && (typeof result === "object" || typeof result === "function")
      && typeof Reflect.get(result, "then") === "function") {
      throw new JarvisError("MEMORY_CONTENT_REPRESENTATION_ASYNC");
    }
    return result;
  } finally {
    for (const value of owned) value.fill(0);
  }
}

function shortEscape(byte: number): number | undefined {
  switch (byte) {
    case 8: return 98;
    case 9: return 116;
    case 10: return 110;
    case 12: return 102;
    case 13: return 114;
    case 34: return 34;
    case 92: return 92;
    default: return undefined;
  }
}

function escapedByteLength(byte: number): number {
  return shortEscape(byte) !== undefined ? 2 : byte < 32 ? 6 : 1;
}

function escapeJsonBytes(value: Buffer, output: Buffer): void {
  let offset = 0;
  for (const byte of value) {
    const short = shortEscape(byte);
    if (short !== undefined) {
      output[offset++] = 92;
      output[offset++] = short;
    } else if (byte < 32) {
      output[offset++] = 92;
      output[offset++] = 117;
      output[offset++] = 48;
      output[offset++] = 48;
      output[offset++] = HEX[byte >>> 4]!;
      output[offset++] = HEX[byte & 15]!;
    } else output[offset++] = byte;
  }
}
