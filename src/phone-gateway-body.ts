import type { IncomingMessage } from "node:http";
import { PHONE_ERROR_CODES, PHONE_GATEWAY_LIMITS, type PhoneErrorCode } from "./phone-gateway-protocol.js";
import { headerValues } from "./phone-gateway-config.js";

export async function readPostBody(request: IncomingMessage): Promise<
  | { readonly kind: "ok"; readonly buffer: Buffer }
  | { readonly kind: "error"; readonly status: number; readonly code: PhoneErrorCode }
> {
  if (headerValues(request.rawHeaders, "transfer-encoding").length > 0) {
    return { kind: "error", status: 400, code: PHONE_ERROR_CODES.PHONE_REQUEST_INVALID };
  }
  const types = headerValues(request.rawHeaders, "content-type");
  if (types.length !== 1 || types[0]?.toLowerCase() !== "application/json; charset=utf-8") {
    return { kind: "error", status: 400, code: PHONE_ERROR_CODES.PHONE_REQUEST_INVALID };
  }
  const lengths = headerValues(request.rawHeaders, "content-length");
  if (lengths.length !== 1 || lengths[0] === undefined || !/^[1-9][0-9]*$/.test(lengths[0])) {
    return { kind: "error", status: 400, code: PHONE_ERROR_CODES.PHONE_REQUEST_INVALID };
  }
  const declared = Number(lengths[0]);
  if (declared > PHONE_GATEWAY_LIMITS.postBody) {
    request.resume();
    return { kind: "error", status: 413, code: PHONE_ERROR_CODES.PHONE_REQUEST_INVALID };
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const piece = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    size += piece.byteLength;
    if (size > PHONE_GATEWAY_LIMITS.postBody) {
      request.destroy();
      return { kind: "error", status: 413, code: PHONE_ERROR_CODES.PHONE_REQUEST_INVALID };
    }
    chunks.push(piece);
  }
  if (size !== declared) return { kind: "error", status: 400, code: PHONE_ERROR_CODES.PHONE_REQUEST_INVALID };
  return { kind: "ok", buffer: Buffer.concat(chunks, size) };
}

export function validateMemoryBody(path: string, buffer: Buffer): boolean {
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(buffer); } catch (error) {
    if (error instanceof TypeError) return false;
    throw error;
  }
  if (text.charCodeAt(0) === 0xfeff) return false;
  for (const ch of text) {
    const code = ch.charCodeAt(0);
    if (code < 32 && code !== 9 && code !== 10 && code !== 13) return false;
  }
  const keys = topLevelKeys(text);
  if (keys === undefined || new Set(keys).size !== keys.length) return false;
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch (error) {
    if (error instanceof SyntaxError) return false;
    throw error;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return false;
  if (keys.some(key => key === "__proto__" || key === "constructor" || key === "prototype")) return false;
  if (path === "/api/v1/memory/provider/verify") {
    return buffer.byteLength <= 32768 && Reflect.get(parsed, "schema_version") === 4;
  }
  if (Reflect.get(parsed, "schema_version") !== 1) return false;
  if (path === "/api/v1/memory/reconcile") {
    return buffer.byteLength <= 512 && keys.length === 2 && keys.includes("outbox_id")
      && typeof Reflect.get(parsed, "outbox_id") === "string"
      && /^memout:scoped:v4:[0-9a-f]{64}$/.test(Reflect.get(parsed, "outbox_id"));
  }
  if (path === "/api/v1/memory/context") {
    if (keys.length !== 4 || !["schema_version", "query", "limit", "max_bytes"].every(key => keys.includes(key))) return false;
    const query = Reflect.get(parsed, "query"); const limit = Reflect.get(parsed, "limit");
    const bytes = Reflect.get(parsed, "max_bytes");
    return typeof query === "string" && query === query.trim() && query === query.normalize("NFC")
      && Buffer.byteLength(query) >= 1 && Buffer.byteLength(query) <= 512
      && typeof limit === "number" && Number.isInteger(limit) && limit >= 1 && limit <= 32
      && typeof bytes === "number" && Number.isInteger(bytes) && bytes >= 1024 && bytes <= 65536;
  }
  if (path === "/api/v1/memory/search") {
    if (keys.length !== 3 || !keys.includes("schema_version") || !keys.includes("query") || !keys.includes("limit")) {
      return false;
    }
    const query = Reflect.get(parsed, "query");
    const limit = Reflect.get(parsed, "limit");
    return typeof query === "string" && query === query.trim() && query === query.normalize("NFC")
      && Buffer.byteLength(query) >= 1 && Buffer.byteLength(query) <= 512
      && typeof limit === "number" && Number.isInteger(limit) && limit >= 1 && limit <= 20;
  }
  if (path === "/api/v1/memory/records/detail") {
    if (keys.length !== 2 || !keys.includes("schema_version") || !keys.includes("record_token")) return false;
    const token = Reflect.get(parsed, "record_token");
    return typeof token === "string" && /^[A-Za-z0-9_-]{43}$/.test(token);
  }
  return false;
}

function topLevelKeys(text: string): string[] | undefined {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{")) return undefined;
  const keys: string[] = [];
  let index = 1;
  const skip = (): void => {
    while (index < trimmed.length && (trimmed[index] === " " || trimmed[index] === "\n"
      || trimmed[index] === "\r" || trimmed[index] === "\t")) index += 1;
  };
  skip();
  if (trimmed[index] === "}") return keys;
  while (index < trimmed.length) {
    if (trimmed[index] !== "\"") return undefined;
    const read = readJsonString(trimmed, index);
    if (read === undefined) return undefined;
    keys.push(read.value);
    index = read.end;
    skip();
    if (trimmed[index] !== ":") return undefined;
    index += 1;
    skip();
    const end = skipJsonValue(trimmed, index);
    if (end === undefined) return undefined;
    index = end;
    skip();
    if (trimmed[index] === "}") return keys;
    if (trimmed[index] !== ",") return undefined;
    index += 1;
    skip();
  }
  return undefined;
}

function readJsonString(text: string, start: number): { readonly value: string; readonly end: number } | undefined {
  if (text[start] !== "\"") return undefined;
  let index = start + 1;
  let value = "";
  while (index < text.length) {
    const ch = text[index];
    if (ch === "\"") return { value, end: index + 1 };
    if (ch === "\\") {
      index += 2;
      continue;
    }
    value += ch;
    index += 1;
  }
  return undefined;
}

function skipJsonValue(text: string, start: number): number | undefined {
  let index = start;
  const skip = (): void => {
    while (index < text.length && (text[index] === " " || text[index] === "\n" || text[index] === "\r" || text[index] === "\t")) {
      index += 1;
    }
  };
  skip();
  const ch = text[index];
  if (ch === "\"") {
    const read = readJsonString(text, index);
    return read?.end;
  }
  if (ch === "{") {
    index += 1;
    skip();
    if (text[index] === "}") return index + 1;
    for (;;) {
      const key = readJsonString(text, index);
      if (key === undefined) return undefined;
      index = key.end; skip();
      if (text[index] !== ":") return undefined;
      index += 1;
      const end = skipJsonValue(text, index);
      if (end === undefined) return undefined;
      index = end; skip();
      if (text[index] === "}") return index + 1;
      if (text[index] !== ",") return undefined;
      index += 1; skip();
    }
  }
  if (ch === "[") {
    index += 1; skip();
    if (text[index] === "]") return index + 1;
    for (;;) {
      const end = skipJsonValue(text, index);
      if (end === undefined) return undefined;
      index = end; skip();
      if (text[index] === "]") return index + 1;
      if (text[index] !== ",") return undefined;
      index += 1; skip();
    }
  }
  if (ch === "t" || ch === "f" || ch === "n" || ch === "-" || (ch !== undefined && ch >= "0" && ch <= "9")) {
    while (index < text.length && /[0-9eE+tnfalsu.-]/.test(text[index] ?? "")) index += 1;
    return index;
  }
  return undefined;
}
