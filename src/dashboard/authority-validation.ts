import { JarvisError } from "../db.js";
import {
  CANCEL_KEYS,
  DASHBOARD_SCHEMA_VERSION,
  EXECUTE_KEYS,
  FIELD_LIMIT,
  ID_LIMIT,
  RETRY_KEYS,
  type CancelRequest,
  type ExecuteRequest,
  type ReceiptDecisionRequest,
  type RetryRequest,
} from "./contracts.js";
import { parseReceiptDecision } from "./validation.js";

export type { CancelRequest, ExecuteRequest, RetryRequest } from "./contracts.js";

type Fail = () => never;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function failWith(code: string): Fail {
  return () => {
    throw new JarvisError(code);
  };
}

function record(value: unknown, fail: Fail): Record<string, unknown> {
  if (!isRecord(value)) fail();
  return value;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], fail: Fail): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) fail();
}

function nfcString(value: unknown, max: number, fail: Fail): string {
  if (typeof value !== "string" || value !== value.normalize("NFC") || value.trim().length === 0) fail();
  const bytes = Buffer.byteLength(value, "utf8");
  if (bytes < 1 || bytes > max) fail();
  return value;
}

export function parseAuthorityDecision(value: unknown): ReceiptDecisionRequest {
  if (!isRecord(value) || !Object.hasOwn(value, "receipt")) {
    throw new JarvisError("AUTHORITY_RECEIPT_REQUIRED");
  }
  return parseReceiptDecision(value);
}

export function parseExecuteRequest(value: unknown): ExecuteRequest {
  const fail = failWith("VALIDATION_ERROR");
  const input = record(value, fail);
  exactKeys(input, EXECUTE_KEYS, fail);
  if (input.schema_version !== DASHBOARD_SCHEMA_VERSION) fail();
  return { schema_version: DASHBOARD_SCHEMA_VERSION };
}

export function parseCancelRequest(value: unknown): CancelRequest {
  const fail = failWith("VALIDATION_ERROR");
  const input = record(value, fail);
  exactKeys(input, CANCEL_KEYS, fail);
  if (input.schema_version !== DASHBOARD_SCHEMA_VERSION) fail();
  return {
    schema_version: DASHBOARD_SCHEMA_VERSION,
    request_id: nfcString(input.request_id, ID_LIMIT, fail),
    nonce: nfcString(input.nonce, ID_LIMIT, fail),
    run_id: nfcString(input.run_id, ID_LIMIT, fail),
    reason: nfcString(input.reason, FIELD_LIMIT, fail),
  };
}

export function parseRetryRequest(value: unknown): RetryRequest {
  const fail = failWith("VALIDATION_ERROR");
  const input = record(value, fail);
  exactKeys(input, RETRY_KEYS, fail);
  if (input.schema_version !== DASHBOARD_SCHEMA_VERSION) fail();
  return {
    schema_version: DASHBOARD_SCHEMA_VERSION,
    request_id: nfcString(input.request_id, ID_LIMIT, fail),
    nonce: nfcString(input.nonce, ID_LIMIT, fail),
  };
}
