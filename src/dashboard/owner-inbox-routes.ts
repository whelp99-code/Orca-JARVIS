import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { JarvisError, type AuthorityDb } from "../db.js";
import { OwnerInbox, type OwnerInboxDecision } from "../owner-inbox.js";
import { composeOwnerInbox } from "../remote-approval-compose.js";
import type { RemoteApprovalService } from "../remote-approval.js";
import { writeDashboardError, writeDashboardJson } from "./http.js";
import { hasExactMutationOrigin } from "./request-boundary.js";
import { sessionMatchesCsrf, type DashboardSessionStore } from "./session.js";
import { parseSecondBrainStrictJsonBytes } from "../second-brain-strict-json.js";

const CODES = {
  OWNER_INBOX_UNCONFIGURED: { status: 503, code: "OWNER_INBOX_UNCONFIGURED", message: "Owner signing key is not configured" },
  OWNER_INBOX_IDENTITY_REQUIRED: { status: 401, code: "OWNER_INBOX_IDENTITY_REQUIRED", message: "Owner session required" },
  OWNER_INBOX_INVALID: { status: 400, code: "OWNER_INBOX_INVALID", message: "Invalid owner decision" },
  OWNER_INBOX_ACTION_FORBIDDEN: { status: 403, code: "OWNER_INBOX_ACTION_FORBIDDEN", message: "Action is not in the owner inbox" },
  OWNER_INBOX_NOT_PENDING: { status: 409, code: "OWNER_INBOX_NOT_PENDING", message: "Request is not pending" },
  OWNER_INBOX_DIGEST_MISMATCH: { status: 409, code: "OWNER_INBOX_DIGEST_MISMATCH", message: "Digest does not match the staged request" },
  OWNER_INBOX_EXPIRED: { status: 409, code: "OWNER_INBOX_EXPIRED", message: "Request expired" },
  OWNER_INBOX_NOT_FOUND: { status: 404, code: "OWNER_INBOX_NOT_FOUND", message: "Request not found" },
} as const;

const CSRF = "x-jarvis-csrf";
const MAX_BODY = 4096;

export async function tryHandleOwnerInbox(input: Readonly<{
  path: string;
  request: IncomingMessage;
  response: ServerResponse;
  requestId: string;
  db: AuthorityDb;
  session: DashboardSessionStore;
  origin: string;
  remoteApproval?: RemoteApprovalService;
  ownerInbox?: OwnerInbox;
}>): Promise<boolean> {
  const method = input.request.method;
  if (input.path !== "/api/v1/owner-inbox" && input.path !== "/api/v1/owner-inbox/decide") return false;
  if (method !== "GET" && method !== "POST") {
    writeDashboardError(input.response, { status: 405, code: "VALIDATION_ERROR", message: "Validation error", requestId: input.requestId });
    return true;
  }
  if (input.path === "/api/v1/owner-inbox" && method !== "GET") {
    writeDashboardError(input.response, { status: 405, code: "VALIDATION_ERROR", message: "Validation error", requestId: input.requestId });
    return true;
  }
  if (input.path.endsWith("/decide") && method !== "POST") {
    writeDashboardError(input.response, { status: 405, code: "VALIDATION_ERROR", message: "Validation error", requestId: input.requestId });
    return true;
  }
  const raw = method === "POST" ? await readBody(input.request) : Buffer.alloc(0);
  if (raw === undefined) {
    writeDashboardError(input.response, { status: 400, code: "VALIDATION_ERROR", message: "Validation error", requestId: input.requestId });
    return true;
  }
  const admitted = admit(input, raw, method);
  if (admitted === undefined) {
    writeDashboardError(input.response, { ...CODES.OWNER_INBOX_IDENTITY_REQUIRED, requestId: input.requestId });
    return true;
  }
  const inbox = input.ownerInbox ?? composeOwnerInbox(input.db);
  try {
    if (method === "GET") {
      writeDashboardJson(input.response, {
        status: 200, requestId: input.requestId, body: { schema_version: 1, items: inbox.list() },
      });
      return true;
    }
    const parsed = parseDecision(parseSecondBrainStrictJsonBytes(raw));
    if (parsed === undefined) {
      writeDashboardError(input.response, { status: 400, code: "VALIDATION_ERROR", message: "Validation error", requestId: input.requestId });
      return true;
    }
    const result = inbox.decide({ ...parsed, session_id: admitted });
    writeDashboardJson(input.response, { status: 200, requestId: input.requestId, body: { schema_version: 1, ...result } });
  } catch (error) {
    if (!(error instanceof JarvisError)) throw error;
    const mapped = CODES[error.code as keyof typeof CODES];
    if (mapped === undefined) throw error;
    writeDashboardError(input.response, { ...mapped, requestId: input.requestId });
  }
  return true;
}

function admit(input: {
  request: IncomingMessage;
  origin: string;
  session: DashboardSessionStore;
  remoteApproval?: RemoteApprovalService;
  path: string;
}, body: Buffer, method: "GET" | "POST"): string | undefined {
  const csrf = header(input.request.headers[CSRF]);
  const local = hasExactMutationOrigin(input.request, input.origin) && sessionMatchesCsrf(input.session, csrf);
  const ingress = input.remoteApproval?.resolver(input.request, body) ?? null;
  if (local && ingress) return undefined;
  if (local && csrf !== undefined) return `local:${createHash("sha256").update(csrf).digest("hex")}`;
  if (ingress && ingress.request_method === method && ingress.canonical_path === input.path) {
    return ingress.gateway_session_digest;
  }
  return undefined;
}

async function readBody(request: IncomingMessage): Promise<Buffer | undefined> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY) return undefined;
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function header(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function parseDecision(body: unknown): { request_id: string; decision: OwnerInboxDecision; command_digest: string } | undefined {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return undefined;
  const record = body as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== 3) return undefined;
  const { request_id, decision, command_digest } = record;
  if (typeof request_id !== "string" || request_id.length === 0 || request_id.length > 256) return undefined;
  if (decision !== "approve" && decision !== "reject") return undefined;
  if (typeof command_digest !== "string" || !command_digest.startsWith("sha256:")) return undefined;
  return { request_id, decision, command_digest };
}
