import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from "node:http";
import { parseSecondBrainStrictJsonBytes } from "../second-brain-strict-json.js";
import { DASHBOARD_SCHEMA_VERSION } from "./contracts.js";
import { DASHBOARD_ERROR_CODES, writeDashboardError, writeDashboardJson } from "./http.js";
import { sessionMatchesCsrf, type DashboardSessionStore } from "./session.js";

export const MAX_JSON_BODY_BYTES = 64 * 1024;

export const POST_ERROR_CODES = {
  LOCAL_SESSION_REQUIRED: "LOCAL_SESSION_REQUIRED",
  UNSUPPORTED_MEDIA_TYPE: "UNSUPPORTED_MEDIA_TYPE",
  BODY_TOO_LARGE: "BODY_TOO_LARGE",
  JSON_INVALID: "JSON_INVALID",
  MEMORY_REQUEST_TOO_LARGE: "MEMORY_REQUEST_TOO_LARGE",
  MEMORY_INPUT_INVALID: "MEMORY_INPUT_INVALID",
} as const;

export type PostErrorCode = (typeof POST_ERROR_CODES)[keyof typeof POST_ERROR_CODES];

export type PostBoundaryResult =
  | { readonly kind: "accepted"; readonly value: unknown }
  | { readonly kind: "rejected"; readonly status: number; readonly code: PostErrorCode };

export type JsonPostInput = {
  readonly request: IncomingMessage;
  readonly session: DashboardSessionStore;
  readonly origin: string;
  readonly path: string;
};

const POST_ERROR_MESSAGES = {
  LOCAL_SESSION_REQUIRED: "Local session required",
  UNSUPPORTED_MEDIA_TYPE: "Unsupported media type",
  BODY_TOO_LARGE: "Body too large",
  JSON_INVALID: "Invalid JSON",
  MEMORY_REQUEST_TOO_LARGE: "Memory request too large",
  MEMORY_INPUT_INVALID: "Invalid Memory input",
} as const satisfies Record<PostErrorCode, string>;

const CSRF_HEADER = "x-jarvis-csrf";
const JSON_MEDIA_TYPE = "application/json";

type BodyRead =
  | { readonly kind: "ok"; readonly buffer: Buffer }
  | { readonly kind: "too_large" };

export async function readJsonPost(input: JsonPostInput): Promise<PostBoundaryResult> {
  if (!hasExactMutationOrigin(input.request, input.origin)) {
    return reject(403, POST_ERROR_CODES.LOCAL_SESSION_REQUIRED);
  }
  if (!sessionMatchesCsrf(input.session, headerValue(input.request.headers[CSRF_HEADER]))) {
    return reject(403, POST_ERROR_CODES.LOCAL_SESSION_REQUIRED);
  }
  if (!isJsonContentType(input.request.headers["content-type"])) {
    return reject(415, POST_ERROR_CODES.UNSUPPORTED_MEDIA_TYPE);
  }
  const body = await readLimitedBody(input.request, MAX_JSON_BODY_BYTES);
  switch (body.kind) {
    case "too_large":
      return reject(413, input.path.startsWith("/api/v1/memory/")
        ? POST_ERROR_CODES.MEMORY_REQUEST_TOO_LARGE : POST_ERROR_CODES.BODY_TOO_LARGE);
    case "ok":
      break;
    default:
      return assertNever(body);
  }
  const value = parseSecondBrainStrictJsonBytes(body.buffer);
  if (value === undefined) return reject(400, input.path.startsWith("/api/v1/memory/")
    ? POST_ERROR_CODES.MEMORY_INPUT_INVALID : POST_ERROR_CODES.JSON_INVALID);
  return { kind: "accepted", value };
}

export function writePostBoundaryError(
  response: ServerResponse,
  requestId: string,
  failure: Extract<PostBoundaryResult, { readonly kind: "rejected" }>,
): void {
  switch (failure.code) {
    case POST_ERROR_CODES.LOCAL_SESSION_REQUIRED:
      writeDashboardError(response, {
        status: failure.status,
        code: DASHBOARD_ERROR_CODES.LOCAL_SESSION_REQUIRED,
        requestId,
      });
      return;
    case POST_ERROR_CODES.UNSUPPORTED_MEDIA_TYPE:
    case POST_ERROR_CODES.BODY_TOO_LARGE:
    case POST_ERROR_CODES.JSON_INVALID:
    case POST_ERROR_CODES.MEMORY_REQUEST_TOO_LARGE:
    case POST_ERROR_CODES.MEMORY_INPUT_INVALID:
      writeDashboardJson(response, {
        status: failure.status,
        requestId,
        body: {
          schema_version: DASHBOARD_SCHEMA_VERSION,
          error: {
            code: failure.code,
            message: POST_ERROR_MESSAGES[failure.code],
            request_id: requestId,
          },
        },
      });
      return;
    default:
      assertNever(failure.code);
  }
}

function reject(status: number, code: PostErrorCode): Extract<PostBoundaryResult, { readonly kind: "rejected" }> {
  return { kind: "rejected", status, code };
}

export function hasExactMutationOrigin(
  request: Pick<IncomingMessage, "rawHeaders">,
  expected: string,
): boolean {
  let found: string | undefined;
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    const name = request.rawHeaders[index];
    if (name?.toLowerCase() !== "origin") continue;
    if (found !== undefined) return false;
    found = request.rawHeaders[index + 1];
  }
  return found === expected;
}

function isJsonContentType(header: string | readonly string[] | undefined): boolean {
  const value = headerValue(header);
  if (value === undefined) return false;
  const separator = value.indexOf(";");
  const media = (separator === -1 ? value : value.slice(0, separator)).trim().toLowerCase();
  return media === JSON_MEDIA_TYPE;
}

function headerValue(value: string | readonly string[] | undefined): string | undefined {
  if (typeof value === "string") return value;
  if (value === undefined || value.length !== 1) return undefined;
  return value[0];
}

function declaredLength(headers: IncomingHttpHeaders): number | undefined {
  const raw = headerValue(headers["content-length"]);
  if (raw === undefined || !/^[0-9]+$/.test(raw)) return undefined;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed)) return undefined;
  return parsed;
}

async function readLimitedBody(request: IncomingMessage, maxBytes: number): Promise<BodyRead> {
  const declared = declaredLength(request.headers);
  if (declared !== undefined && declared > maxBytes) {
    request.resume();
    return { kind: "too_large" };
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const piece = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    size += piece.byteLength;
    if (size > maxBytes) {
      request.destroy();
      return { kind: "too_large" };
    }
    chunks.push(piece);
  }
  return { kind: "ok", buffer: Buffer.concat(chunks, size) };
}

function assertNever(value: never): never {
  throw new Error(`unexpected post boundary: ${JSON.stringify(value)}`);
}
