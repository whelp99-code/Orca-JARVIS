import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { DASHBOARD_SCHEMA_VERSION } from "./contracts.js";

export const DASHBOARD_ERROR_CODES = {
  NOT_FOUND: "NOT_FOUND",
  LOCAL_SESSION_REQUIRED: "LOCAL_SESSION_REQUIRED",
  INTERNAL_ERROR: "INTERNAL_ERROR",
  SSE_CAPACITY_EXCEEDED: "SSE_CAPACITY_EXCEEDED",
  AUTHORITY_NOT_READY: "AUTHORITY_NOT_READY",
  MEMORY_PROJECTION_AUTHORITY_NOT_READY: "MEMORY_PROJECTION_AUTHORITY_NOT_READY",
  MEMORY_SURFACE_READ_CHANGED: "MEMORY_SURFACE_READ_CHANGED",
  VALIDATION_ERROR: "VALIDATION_ERROR",
  OWNER_INBOX_UNCONFIGURED: "OWNER_INBOX_UNCONFIGURED",
  OWNER_INBOX_IDENTITY_REQUIRED: "OWNER_INBOX_IDENTITY_REQUIRED",
  OWNER_INBOX_WEBAUTHN_REQUIRED: "OWNER_INBOX_WEBAUTHN_REQUIRED",
  OWNER_INBOX_ASSERTION_REJECTED: "OWNER_INBOX_ASSERTION_REJECTED",
  OWNER_INBOX_REPLAY: "OWNER_INBOX_REPLAY",
  OWNER_INBOX_INVALID: "OWNER_INBOX_INVALID",
  OWNER_INBOX_ACTION_FORBIDDEN: "OWNER_INBOX_ACTION_FORBIDDEN",
  OWNER_INBOX_NOT_PENDING: "OWNER_INBOX_NOT_PENDING",
  OWNER_INBOX_DIGEST_MISMATCH: "OWNER_INBOX_DIGEST_MISMATCH",
  OWNER_INBOX_EXPIRED: "OWNER_INBOX_EXPIRED",
  OWNER_INBOX_NOT_FOUND: "OWNER_INBOX_NOT_FOUND",
  OWNER_INBOX_KEY_MISMATCH: "OWNER_INBOX_KEY_MISMATCH",
} as const;

export type DashboardErrorCode = (typeof DASHBOARD_ERROR_CODES)[keyof typeof DASHBOARD_ERROR_CODES];

const ERROR_MESSAGES = {
  NOT_FOUND: "Not found",
  LOCAL_SESSION_REQUIRED: "Local session required",
  INTERNAL_ERROR: "Internal error",
  SSE_CAPACITY_EXCEEDED: "Too many live dashboard connections. Retry after a connection closes.",
  AUTHORITY_NOT_READY: "Authority is not ready",
  MEMORY_PROJECTION_AUTHORITY_NOT_READY: "Memory projections require initialization",
  MEMORY_SURFACE_READ_CHANGED: "Memory access changed during the request. Refresh and try again.",
  VALIDATION_ERROR: "Validation error",
  OWNER_INBOX_UNCONFIGURED: "Owner signing key is not configured",
  OWNER_INBOX_IDENTITY_REQUIRED: "Owner session required",
  OWNER_INBOX_WEBAUTHN_REQUIRED: "Passkey assertion required",
  OWNER_INBOX_ASSERTION_REJECTED: "Passkey assertion rejected",
  OWNER_INBOX_REPLAY: "Passkey assertion already used",
  OWNER_INBOX_INVALID: "Invalid owner decision",
  OWNER_INBOX_ACTION_FORBIDDEN: "Action is not in the owner inbox",
  OWNER_INBOX_NOT_PENDING: "Request is not pending",
  OWNER_INBOX_DIGEST_MISMATCH: "Digest does not match the staged request",
  OWNER_INBOX_EXPIRED: "Request expired",
  OWNER_INBOX_NOT_FOUND: "Request not found",
  OWNER_INBOX_KEY_MISMATCH: "Decision key does not match the enrolled owner key",
} as const satisfies Record<DashboardErrorCode, string>;

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost"]);

export type DashboardErrorEnvelope = {
  readonly schema_version: 1;
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly request_id: string;
  };
};

export type DashboardJsonWrite = {
  readonly status: number;
  readonly body: unknown;
  readonly requestId: string;
};

export type DashboardErrorWrite = {
  readonly status: number;
  readonly code: DashboardErrorCode;
  readonly requestId: string;
};

export type DashboardHtmlWrite = {
  readonly status: number;
  readonly body: string;
  readonly requestId: string;
};

export function createRequestId(request?: IncomingMessage): string {
  void request;
  return randomUUID();
}

export function isLoopbackHostHeader(header: string | undefined): boolean {
  if (header === undefined) return false;
  const value = header.trim();
  if (value.length === 0 || /[\s/?#@,]/.test(value)) return false;
  if (value.startsWith("[")) return false;
  const colon = value.lastIndexOf(":");
  const hostname = colon === -1 ? value : value.slice(0, colon);
  if (colon !== -1) {
    const port = value.slice(colon + 1);
    if (!/^[1-9]\d{0,4}$/.test(port)) return false;
    const parsed = Number(port);
    if (parsed > 65535) return false;
  }
  return LOOPBACK_HOSTS.has(hostname.toLowerCase());
}

export function writeDashboardJson(response: ServerResponse, input: DashboardJsonWrite): void {
  writeBody(response, {
    status: input.status,
    requestId: input.requestId,
    contentType: "application/json; charset=utf-8",
    payload: JSON.stringify(input.body),
  });
}

export function writeDashboardError(response: ServerResponse, input: DashboardErrorWrite): void {
  const body: DashboardErrorEnvelope = {
    schema_version: DASHBOARD_SCHEMA_VERSION,
    error: {
      code: input.code,
      message: ERROR_MESSAGES[input.code],
      request_id: input.requestId,
    },
  };
  writeDashboardJson(response, { status: input.status, body, requestId: input.requestId });
}

export function writeDashboardHtml(response: ServerResponse, input: DashboardHtmlWrite): void {
  writeBody(response, {
    status: input.status,
    requestId: input.requestId,
    contentType: "text/html; charset=utf-8",
    payload: input.body,
  });
}

function writeBody(
  response: ServerResponse,
  input: {
    readonly status: number;
    readonly requestId: string;
    readonly contentType: string;
    readonly payload: string;
  },
): void {
  if (response.headersSent) return;
  response.statusCode = input.status;
  response.setHeader("X-Request-Id", input.requestId);
  response.setHeader("Content-Type", input.contentType);
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Content-Length", Buffer.byteLength(input.payload));
  response.end(input.payload);
}
