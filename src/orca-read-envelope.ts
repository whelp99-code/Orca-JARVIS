import { JarvisError } from "./db.js";
import { parseBoundedStrictJson } from "./strict-json.js";

export const ORCA_READ_MAX_BYTES = 1_000_000;
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && Object.getPrototypeOf(value) === Object.prototype;

/** Only verified transport errors may be isolated as an unavailable observation. */
export function isTransientOrcaReadFailure(error: unknown): boolean {
  return error instanceof JarvisError
    && (error.code === "ORCA_CLI_UNAVAILABLE" || error.code === "ORCA_CLI_TIMEOUT");
}

function rejectEnvelope(value: Record<string, unknown>): never {
  const error = value.error;
  if (!Object.hasOwn(value, "error") || !record(error) || !Object.hasOwn(error, "code")
    || !Object.hasOwn(error, "message") || typeof error.code !== "string" || typeof error.message !== "string"
    || error.code.length === 0 || error.code.length > 128
    || Object.keys(value).some(key => !["id", "ok", "error", "_meta", "version"].includes(key))
    || Object.keys(error).some(key => !["code", "message", "data"].includes(key))) {
    throw new JarvisError("ORCA_CLI_SCHEMA_INVALID");
  }
  switch (error.code) {
    case "runtime_unavailable": throw new JarvisError("ORCA_CLI_UNAVAILABLE");
    case "runtime_timeout": throw new JarvisError("ORCA_CLI_TIMEOUT");
    case "terminal_handle_stale": case "terminal_gone": throw new JarvisError("ORCA_TERMINAL_STALE");
    case "permission_denied": case "unauthorized": throw new JarvisError("ORCA_PERMISSION_DENIED");
    case "invalid_runtime_response": throw new JarvisError("ORCA_CLI_SCHEMA_INVALID");
    default: throw new JarvisError("ORCA_CLI_REJECTED");
  }
}

export function parseOrcaReadPayload(text: string): Record<string, unknown> {
  if (Buffer.byteLength(text, "utf8") > ORCA_READ_MAX_BYTES) throw new JarvisError("ORCA_CLI_OUTPUT_LIMIT");
  // Validate the entire success or error envelope before inspecting its ok field.
  // The byte limit bounds a large terminal list without imposing the memory protocol's 4096-node cap.
  const value = parseBoundedStrictJson(text, { depth: 64, nodes: 500_000, workItems: 1_000_000, characters: ORCA_READ_MAX_BYTES });
  if (value === undefined) throw new JarvisError("ORCA_CLI_JSON_INVALID");
  if (!record(value) || !Object.hasOwn(value, "ok") || ("version" in value && value.version !== 1)) throw new JarvisError("ORCA_CLI_SCHEMA_INVALID");
  if (value.ok === false) return rejectEnvelope(value);
  if (value.ok !== true || !Object.hasOwn(value, "result") || !record(value.result)
    || Object.keys(value).some(key => !["id", "ok", "result", "_meta", "version"].includes(key))) {
    throw new JarvisError("ORCA_CLI_SCHEMA_INVALID");
  }
  return value.result;
}

export function decodeOrcaReadOutput(bytes: Buffer): string {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) throw new JarvisError("ORCA_CLI_JSON_INVALID");
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { throw new JarvisError("ORCA_CLI_JSON_INVALID"); }
}
