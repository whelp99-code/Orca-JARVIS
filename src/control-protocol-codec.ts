import {
  CONTROL_ERROR_CODES,
  CONTROL_FRAME_MAX_BYTES,
  CONTROL_METHODS,
  CONTROL_PROTOCOL_NAME,
  CONTROL_PROTOCOL_VERSION,
  FORBIDDEN_AUTHORITY_FIELDS,
  type ControlError,
  type ControlErrorCode,
  type ControlFrame,
  type ControlMethod,
  type DecodeResult,
} from "./control-protocol.js";

const RFC3339_MILLIS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const VERSION = /^(\d+)\.(\d+)$/;

export type DecodeContext = {
  readonly seenIds?: ReadonlySet<string>;
  readonly generation?: string;
  readonly pendingRequestIds?: ReadonlySet<string>;
};

function error(code: ControlErrorCode, message?: string): ControlError {
  return { code, message: message ?? code, retryable: false };
}

function fail(code: ControlErrorCode, message?: string): DecodeResult {
  return { ok: false, error: error(code, message ?? code) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMethod(value: unknown): value is ControlMethod {
  return typeof value === "string" && (CONTROL_METHODS as readonly string[]).includes(value);
}

function isErrorCode(value: unknown): value is ControlErrorCode {
  return typeof value === "string" && (CONTROL_ERROR_CODES as readonly string[]).includes(value);
}

export function protocolVersionStatus(version: string): ControlErrorCode | undefined {
  const match = VERSION.exec(version);
  if (match === null) return "unsupported_version";
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const current = VERSION.exec(CONTROL_PROTOCOL_VERSION);
  if (current === null) return "internal";
  const currentMajor = Number(current[1]);
  const currentMinor = Number(current[2]);
  if (major !== currentMajor) return "unsupported_version";
  if (minor < currentMinor - 1 || minor > currentMinor) return "unsupported_version";
  return undefined;
}

function hasForbiddenAuthority(value: unknown): boolean {
  if (!isRecord(value)) return false;
  for (const key of FORBIDDEN_AUTHORITY_FIELDS) {
    if (key in value) return true;
  }
  return false;
}

const REQUEST_KEYS = new Set(["protocol", "version", "id", "traceId", "generation", "sentAt", "type", "method", "payload"]);
const RESPONSE_OK_KEYS = new Set(["protocol", "version", "id", "traceId", "generation", "sentAt", "type", "replyTo", "ok", "payload"]);
const RESPONSE_ERR_KEYS = new Set(["protocol", "version", "id", "traceId", "generation", "sentAt", "type", "replyTo", "ok", "error"]);
const EVENT_KEYS = new Set(["protocol", "version", "id", "traceId", "generation", "sentAt", "type", "sequence", "method", "payload"]);

function exactKeys(record: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  const keys = Object.keys(record);
  if (keys.length !== allowed.size) return false;
  return keys.every(key => allowed.has(key));
}

export function encodeControlFrame(frame: ControlFrame): string {
  return `${JSON.stringify(frame)}\n`;
}

export function decodeControlFrame(raw: string | Buffer, context: DecodeContext = {}): DecodeResult {
  const bytes = typeof raw === "string" ? Buffer.byteLength(raw, "utf8") : raw.length;
  if (bytes > CONTROL_FRAME_MAX_BYTES) return fail("invalid_request", "frame_too_large");
  const text = typeof raw === "string" ? raw.replace(/\n$/, "") : raw.toString("utf8").replace(/\n$/, "");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return fail("invalid_request", "malformed_json");
  }
  if (!isRecord(parsed)) return fail("invalid_request", "not_object");
  if (parsed.protocol !== CONTROL_PROTOCOL_NAME) return fail("invalid_request", "protocol");
  if (typeof parsed.version !== "string") return fail("invalid_request", "version");
  const versionError = protocolVersionStatus(parsed.version);
  if (versionError) return fail(versionError);
  if (typeof parsed.id !== "string" || parsed.id.length === 0) return fail("invalid_request", "id");
  if (context.seenIds?.has(parsed.id)) return fail("conflict", "duplicate_id");
  if (typeof parsed.traceId !== "string" || parsed.traceId.length === 0) return fail("invalid_request", "traceId");
  if (typeof parsed.generation !== "string" || parsed.generation.length === 0) return fail("invalid_request", "generation");
  if (context.generation !== undefined && parsed.generation !== context.generation) return fail("stale_generation");
  if (typeof parsed.sentAt !== "string" || !RFC3339_MILLIS.test(parsed.sentAt)) return fail("invalid_request", "sentAt");
  if (parsed.type === "request") {
    if (!exactKeys(parsed, REQUEST_KEYS)) return fail("invalid_request", "unknown_field");
    if (!isMethod(parsed.method)) return fail("invalid_request", "unknown_method");
    if (hasForbiddenAuthority(parsed.payload)) return fail("unauthorized", "authority_field");
    return {
      ok: true,
      frame: {
        protocol: CONTROL_PROTOCOL_NAME,
        version: parsed.version,
        id: parsed.id,
        traceId: parsed.traceId,
        generation: parsed.generation,
        sentAt: parsed.sentAt,
        type: "request",
        method: parsed.method,
        payload: parsed.payload,
      },
    };
  }
  if (parsed.type === "response") {
    if (typeof parsed.replyTo !== "string" || parsed.replyTo.length === 0) return fail("invalid_request", "replyTo");
    if (context.pendingRequestIds && !context.pendingRequestIds.has(parsed.replyTo)) return fail("invalid_request", "response_without_request");
    if (parsed.ok === true) {
      if (!exactKeys(parsed, RESPONSE_OK_KEYS)) return fail("invalid_request", "unknown_field");
      return {
        ok: true,
        frame: {
          protocol: CONTROL_PROTOCOL_NAME,
          version: parsed.version,
          id: parsed.id,
          traceId: parsed.traceId,
          generation: parsed.generation,
          sentAt: parsed.sentAt,
          type: "response",
          replyTo: parsed.replyTo,
          ok: true,
          payload: parsed.payload,
        },
      };
    }
    if (parsed.ok === false) {
      if (!exactKeys(parsed, RESPONSE_ERR_KEYS)) return fail("invalid_request", "unknown_field");
      if (!isRecord(parsed.error) || !isErrorCode(parsed.error.code) || typeof parsed.error.message !== "string" || parsed.error.retryable !== false) {
        return fail("invalid_request", "error");
      }
      return {
        ok: true,
        frame: {
          protocol: CONTROL_PROTOCOL_NAME,
          version: parsed.version,
          id: parsed.id,
          traceId: parsed.traceId,
          generation: parsed.generation,
          sentAt: parsed.sentAt,
          type: "response",
          replyTo: parsed.replyTo,
          ok: false,
          error: { code: parsed.error.code, message: parsed.error.message, retryable: false },
        },
      };
    }
    return fail("invalid_request", "ok");
  }
  if (parsed.type === "event") {
    if (!exactKeys(parsed, EVENT_KEYS)) return fail("invalid_request", "unknown_field");
    if (!isMethod(parsed.method)) return fail("invalid_request", "unknown_method");
    if (typeof parsed.sequence !== "number" || !Number.isInteger(parsed.sequence) || parsed.sequence < 0) return fail("invalid_request", "sequence");
    return {
      ok: true,
      frame: {
        protocol: CONTROL_PROTOCOL_NAME,
        version: parsed.version,
        id: parsed.id,
        traceId: parsed.traceId,
        generation: parsed.generation,
        sentAt: parsed.sentAt,
        type: "event",
        sequence: parsed.sequence,
        method: parsed.method,
        payload: parsed.payload,
      },
    };
  }
  return fail("invalid_request", "type");
}

export function mapUnknownErrorCode(code: string): ControlErrorCode {
  return isErrorCode(code) ? code : "internal";
}
