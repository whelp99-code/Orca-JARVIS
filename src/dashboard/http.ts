import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { DASHBOARD_SCHEMA_VERSION } from "./contracts.js";

export const DASHBOARD_ERROR_CODES = {
  NOT_FOUND: "NOT_FOUND",
  LOCAL_SESSION_REQUIRED: "LOCAL_SESSION_REQUIRED",
  INTERNAL_ERROR: "INTERNAL_ERROR",
  AUTHORITY_NOT_READY: "AUTHORITY_NOT_READY",
  MEMORY_PROJECTION_AUTHORITY_NOT_READY: "MEMORY_PROJECTION_AUTHORITY_NOT_READY",
} as const;

export type DashboardErrorCode = (typeof DASHBOARD_ERROR_CODES)[keyof typeof DASHBOARD_ERROR_CODES];

const ERROR_MESSAGES = {
  NOT_FOUND: "Not found",
  LOCAL_SESSION_REQUIRED: "Local session required",
  INTERNAL_ERROR: "Internal error",
  AUTHORITY_NOT_READY: "Authority is not ready",
  MEMORY_PROJECTION_AUTHORITY_NOT_READY: "Memory projections require initialization",
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
