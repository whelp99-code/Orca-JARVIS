import type { ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { consumeSecondBrainContract } from "./second-brain-contract.js";
import { inspectFrozenSchemas } from "./second-brain-frozen.js";
import { parseSecondBrainStrictJson } from "./second-brain-strict-json.js";

export const SECOND_BRAIN_LAUNCHER = "/home/jm/.local/state/second-brain/app/current/bin/second-brain-mcp";
export const SECOND_BRAIN_CONFIG = "/home/jm/.config/second-brain/config.toml";
export const SECOND_BRAIN_PROTOCOL_VERSION = "2025-11-25";
export const SECOND_BRAIN_CONTRACT_PROFILE = "task32-schema4" as const;
export type SecondBrainContractProfile = "task32-schema4" | "remember-schema5" | "cancellation-schema6" | "cancellation-submit-schema7";
export const SECOND_BRAIN_FRAME_BYTES = 1_048_576;
export const SECOND_BRAIN_DEADLINES = { startup: 5_000, read: 10_000, write: 30_000 } as const;
export const SECOND_BRAIN_LIMITS = {
  argument_bytes: 1_000_000,
  correlation_ids: 256,
  diagnostics: 256,
  pending: 8,
  read_queue: 64,
  stderr_bytes: 65_536,
  write_queue: 32,
} as const;
export const SECOND_BRAIN_READ_METHODS = [
  "sb_search",
  "sb_read_page",
  "sb_recent_changes",
  "sb_open_conflicts",
  "sb_resolve_memory_target",
  "sb_generation_status",
  "sb_request_status",
  "sb_cancellation_status",
] as const;
export const SECOND_BRAIN_WRITE_METHOD = "sb_write_request" as const;

export type SecondBrainReadMethod = (typeof SECOND_BRAIN_READ_METHODS)[number];
export type SecondBrainMethod = SecondBrainReadMethod | typeof SECOND_BRAIN_WRITE_METHOD | "sb_submit_cancellation";
export type SecondBrainDisposition = "unavailable" | "cancelled" | "uncertain" | "fatal";
export type SecondBrainOutcome =
  | { readonly kind: "data"; readonly value: Readonly<Record<string, unknown>> }
  | { readonly kind: "no_data"; readonly reason: "empty_result" }
  | { readonly kind: "error"; readonly code: string };
export type SecondBrainDiagnostic = {
  readonly code: string;
  readonly generation: number;
  readonly method?: SecondBrainMethod;
  readonly request_id?: string;
  readonly duration_ms?: number;
  readonly pending_count?: number;
  readonly queued_count?: number;
  readonly stderr_bytes?: number;
  readonly stderr_buffer_bytes?: number;
  readonly buffer_bytes?: number;
  readonly correlation_count?: number;
  readonly listener_count?: number;
  readonly timer_count?: number;
  readonly protocol_version?: string;
  readonly server_name?: string;
  readonly server_version?: string;
  readonly process_state?: "unconfirmed_live";
  readonly process_owned?: boolean;
};
export type SecondBrainTimerHandle = ReturnType<typeof setTimeout> | number;
export type SecondBrainTimers = {
  readonly set: (callback: () => void, delay: number) => SecondBrainTimerHandle;
  readonly clear: (handle: SecondBrainTimerHandle) => void;
};
export type SecondBrainExecFileOptions = {
  readonly encoding: "buffer";
  readonly shell: false;
  readonly env: {
    readonly SB_CONFIG: string;
    readonly SB_MCP_CONTRACT_PROFILE: SecondBrainContractProfile;
  };
  readonly windowsHide: true;
};
export type SecondBrainExecFile = (
  file: string,
  args: readonly string[],
  options: SecondBrainExecFileOptions,
) => ChildProcess;
export type SecondBrainTransportOptions = {
  readonly launcherPath?: string;
  readonly configPath?: string;
  readonly contractPath?: string;
  readonly contractProfile?: SecondBrainContractProfile;
  readonly execFile?: SecondBrainExecFile;
  readonly realpath?: (path: string) => string;
  readonly timers?: SecondBrainTimers;
  readonly clock?: () => number;
  readonly deadlines?: Readonly<typeof SECOND_BRAIN_DEADLINES>;
  readonly safeReadRetries?: 0 | 1;
  readonly shutdownGraceMs?: number;
  readonly onDiagnostic?: (diagnostic: SecondBrainDiagnostic) => void;
};
export type SecondBrainCallOptions = { readonly signal?: AbortSignal; readonly beforeSend?: () => void };
export interface SecondBrainTransport {
  call(
    method: SecondBrainMethod,
    arguments_: Readonly<Record<string, unknown>>,
    options?: SecondBrainCallOptions,
  ): Promise<SecondBrainOutcome>;
  restart(): Promise<void>;
  close(): Promise<void>;
  diagnostics(): readonly SecondBrainDiagnostic[];
}

type ErrorCorrelation = {
  readonly generation: number;
  readonly request_id?: string;
  readonly method?: SecondBrainMethod;
};
export class SecondBrainTransportError extends Error {
  readonly name = "SecondBrainTransportError";
  readonly generation: number;
  readonly request_id?: string;
  readonly method?: SecondBrainMethod;

  constructor(
    readonly code: string,
    readonly disposition: SecondBrainDisposition,
    correlation: ErrorCorrelation,
  ) {
    super(code);
    this.generation = correlation.generation;
    this.request_id = correlation.request_id;
    this.method = correlation.method;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new SecondBrainTransportError("SECOND_BRAIN_MALFORMED_FRAME", "fatal", { generation: 0 });
  }
  return value;
}

export function loadSecondBrainContract(
  path?: string, profile: SecondBrainContractProfile = SECOND_BRAIN_CONTRACT_PROFILE,
): unknown {
  const filename = profile === "cancellation-submit-schema7" ? "second-brain-mcp-v5.json"
    : profile === "cancellation-schema6" ? "second-brain-mcp-v4.json"
    : profile === "remember-schema5" ? "second-brain-mcp-v3.json" : "second-brain-mcp-v1.json";
  const contractPath = path ?? fileURLToPath(new URL(`../contracts/${filename}`, import.meta.url));
  try {
    if (profile !== "task32-schema4" && profile !== "remember-schema5" && profile !== "cancellation-schema6" && profile !== "cancellation-submit-schema7") throw new Error("unknown profile");
    const summary = consumeSecondBrainContract(contractPath);
    if (summary.schemaVersion !== (profile === "cancellation-submit-schema7" ? 7 : profile === "cancellation-schema6" ? 6 : profile === "remember-schema5" ? 5 : 4)) throw new Error("profile mismatch");
    return JSON.parse(readFileSync(contractPath, "utf8"));
  } catch {
    throw new SecondBrainTransportError("SECOND_BRAIN_CONTRACT_MISMATCH", "fatal", { generation: 0 });
  }
}

export function normalizeSecondBrainToolSchemas(observed: unknown, contract: unknown): boolean {
  return inspectFrozenSchemas(observed, contract).matches;
}

export function isSecondBrainReadMethod(method: SecondBrainMethod): method is SecondBrainReadMethod {
  return method !== SECOND_BRAIN_WRITE_METHOD && method !== "sb_submit_cancellation";
}

function exactEmptyResult(method: SecondBrainMethod, value: Readonly<Record<string, unknown>>): boolean {
  let expected: string | undefined;
  switch (method) {
    case "sb_search": expected = "results"; break;
    case "sb_recent_changes": expected = "changes"; break;
    case "sb_open_conflicts": expected = "conflicts"; break;
    case "sb_read_page": case "sb_write_request": case "sb_resolve_memory_target":
    case "sb_generation_status": case "sb_request_status": case "sb_cancellation_status": case "sb_submit_cancellation": expected = undefined; break;
    default: { const exhaustive: never = method; return exhaustive; }
  }
  if (expected === undefined || Object.getPrototypeOf(value) !== Object.prototype) return false;
  const keys = Reflect.ownKeys(value);
  if (keys.length !== 1 || keys[0] !== expected) return false;
  const descriptor = Object.getOwnPropertyDescriptor(value, expected);
  if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) return false;
  const list = descriptor.value;
  return Array.isArray(list) && Object.getPrototypeOf(list) === Array.prototype
    && list.length === 0 && Reflect.ownKeys(list).length === 1;
}

const PROVIDER_ERROR_CODES = new Set([
  "CANCELLATION_AUTHORITY_BINDING_CHANGED", "CANCELLATION_AUTHORITY_UNAVAILABLE",
  "MEMORY_CANCELLATION_ALREADY_RECEIVED", "MEMORY_CANCELLATION_INTENT_INVALID",
  "MEMORY_CANCELLATION_REPLAY_CONFLICT", "CANCELLATION_SUBMISSION_FAILED",
  "CANCELLATION_STATUS_UNAVAILABLE", "CANCELLATION_RESULT_CORRUPT",
  "MEMORY_CANCELLATION_IDENTITY_INVALID", "MEMORY_CANCELLATION_RESULT_INVALID",
  "WRITE_REQUEST_INVALID", "WRITE_REQUEST_OVERSIZE", "WRITE_REQUEST_OPERATION_INVALID",
  "WRITE_REQUEST_OPERATION_CONFUSION", "WRITE_REQUEST_IDENTITY_INVALID", "WRITE_REQUEST_RECEIPT_INVALID",
  "WRITE_REQUEST_PRIOR_REQUIRED", "WRITE_REQUEST_PRIOR_FORBIDDEN", "WRITE_REQUEST_PRIOR_NOT_FOUND",
  "WRITE_REQUEST_PRIOR_MISMATCH", "WRITE_REQUEST_PATH_INVALID", "WRITE_REQUEST_REPLAY_CONFLICT",
  "WRITE_REQUEST_INBOX_UNSAFE", "WRITE_REQUEST_IO_FAILED", "EFFECT_REQUEST_INVALID", "EFFECT_REQUEST_OVERSIZE",
  "EFFECT_OPERATION_CONFUSION", "EFFECT_IDENTITY_INVALID", "EFFECT_SPEC_DIGEST_INVALID",
  "EFFECT_IDEMPOTENCY_INVALID", "EFFECT_ENVELOPE_DIGEST_INVALID", "EFFECT_TARGET_INVALID",
  "EFFECT_TARGET_AMBIGUOUS", "EFFECT_SCOPE_INVALID", "EFFECT_PRIOR_STALE", "EFFECT_PAYLOAD_INVALID",
  "EFFECT_DELEGATION_INVALID", "EFFECT_DELEGATION_USED", "EFFECT_TOMBSTONE_STALE",
  "EFFECT_TOMBSTONE_DELTA_INVALID", "TOMBSTONE_DELTA_TOO_LARGE", "EXTERNAL_RECEIPT_INVALID",
  "MANAGED_ERASURE_SCOPE_INVALID", "EXPORT_SCOPE_AMBIGUOUS", "REAPPROVAL_REQUIRED",
  "TOMBSTONE_FENCE_REQUIRED", "TOMBSTONE_SET_STALE",
]);
function providerToolError(value: Record<string, unknown>): string {
  const content = value.content;
  if (!Array.isArray(content) || content.length !== 1) return "SECOND_BRAIN_TOOL_ERROR";
  const entry = content[0];
  if (!isRecord(entry) || entry.type !== "text") return "SECOND_BRAIN_TOOL_ERROR";
  const text = entry.text; if (typeof text !== "string") return "SECOND_BRAIN_TOOL_ERROR";
  const direct = [...PROVIDER_ERROR_CODES].find(code => text === code || text.endsWith(`: ${code}`));
  if (direct !== undefined) return direct;
  const start = text.indexOf("{"); const encoded = start < 0 ? text : text.slice(start);
  const parsed = parseSecondBrainStrictJson(encoded);
  if (!isRecord(parsed) || parsed.kind !== "error" || parsed.retryable !== false || typeof parsed.code !== "string"
    || !PROVIDER_ERROR_CODES.has(parsed.code)) return "SECOND_BRAIN_TOOL_ERROR";
  return parsed.code;
}
export function normalizeSecondBrainOutcome(
  method: SecondBrainMethod,
  value: Record<string, unknown>,
): SecondBrainOutcome {
  if (value.isError === true) return { kind: "error", code: providerToolError(value) };
  const content = value.content;
  if (!Array.isArray(content) || content.length !== 1) {
    throw new SecondBrainTransportError("SECOND_BRAIN_SCHEMA_MISMATCH", "fatal", { generation: 0 });
  }
  const entry = record(content[0]);
  if (entry.type !== "text" || typeof entry.text !== "string") {
    throw new SecondBrainTransportError("SECOND_BRAIN_SCHEMA_MISMATCH", "fatal", { generation: 0 });
  }
  const decoded = parseSecondBrainStrictJson(entry.text);
  if (decoded === undefined) {
    throw new SecondBrainTransportError("SECOND_BRAIN_PROVIDER_VALUE_INVALID", "fatal", { generation: 0 });
  }
  const parsed = record(decoded);
  if (exactEmptyResult(method, parsed)) return { kind: "no_data", reason: "empty_result" };
  return { kind: "data", value: parsed };
}
