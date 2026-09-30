import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { JarvisError, type AuthorityDb } from "../db.js";
import { OwnerInbox, type AssertionCheck, type InboxAssertion, type OwnerInboxDecision } from "../owner-inbox.js";
import { composeOwnerInbox } from "../remote-approval-compose.js";
import { verifyAssertionCrypto } from "../remote-approval-webauthn.js";
import type { RemoteApprovalService } from "../remote-approval.js";
import { DASHBOARD_ERROR_CODES, writeDashboardError, writeDashboardJson } from "./http.js";
import { hasExactMutationOrigin } from "./request-boundary.js";
import { sessionMatchesCsrf, type DashboardSessionStore } from "./session.js";
import { parseSecondBrainStrictJsonBytes } from "../second-brain-strict-json.js";

const CSRF = "x-jarvis-csrf";
const MAX_BODY = 16_384;
const PATHS = new Set(["/api/v1/owner-inbox", "/api/v1/owner-inbox/decide", "/api/v1/owner-inbox/challenge"]);

export function isOwnerInboxPath(path: string): boolean {
  return PATHS.has(path);
}

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
  assertionCheck?: AssertionCheck;
}>): Promise<boolean> {
  if (!PATHS.has(input.path)) return false;
  const method = input.request.method ?? "";
  if (method === "OPTIONS") {
    writePreflight(input.response, input.origin);
    return true;
  }
  if (input.path === "/api/v1/owner-inbox" && method !== "GET") return methodError(input);
  if (input.path !== "/api/v1/owner-inbox" && method !== "POST") return methodError(input);
  const raw = method === "POST" ? await readBody(input.request) : Buffer.alloc(0);
  if (raw === undefined) return invalid(input);
  const sessionId = admit(input, raw, method === "POST" ? "POST" : "GET");
  if (sessionId === undefined) return coded(input, 401, DASHBOARD_ERROR_CODES.OWNER_INBOX_IDENTITY_REQUIRED);
  const inbox = input.ownerInbox ?? composeOwnerInbox(input.db);
  try {
    if (method === "GET") {
      writeDashboardJson(input.response, {
        status: 200, requestId: input.requestId, body: { schema_version: 1, items: inbox.list() },
      });
      return true;
    }
    const body = parseSecondBrainStrictJsonBytes(raw);
    if (input.path.endsWith("/challenge")) {
      const parsed = parseBinding(body);
      if (parsed === undefined) return invalid(input);
      const issued = inbox.issueChallenge({ ...parsed, session_id: sessionId });
      writeDashboardJson(input.response, { status: 200, requestId: input.requestId, body: { schema_version: 1, ...issued } });
      return true;
    }
    const parsed = parseDecide(body);
    if (parsed === undefined) return invalid(input);
    const result = await inbox.decide({
      ...parsed,
      session_id: sessionId,
      check: input.assertionCheck ?? productionCheck,
      origin: input.origin,
      rpId: new URL(input.origin).hostname,
    });
    writeDashboardJson(input.response, { status: 200, requestId: input.requestId, body: { schema_version: 1, ...result } });
  } catch (error) {
    if (!(error instanceof JarvisError)) throw error;
    const status = statusFor(error.code);
    if (status === undefined) throw error;
    writeDashboardError(input.response, { status, code: error.code as typeof DASHBOARD_ERROR_CODES[keyof typeof DASHBOARD_ERROR_CODES], requestId: input.requestId });
  }
  return true;
}

const productionCheck: AssertionCheck = async (input) => {
  try {
    const verified = await verifyAssertionCrypto({
      assertion: {
        id: input.assertion.id,
        rawId: Buffer.from(input.assertion.id, "base64url"),
        clientDataJSON: Buffer.from(input.assertion.clientDataJSON, "base64url"),
        authenticatorData: Buffer.from(input.assertion.authenticatorData, "base64url"),
        signature: Buffer.from(input.assertion.signature, "base64url"),
        userHandle: Buffer.from(input.assertion.userHandle, "base64url"),
        attachment: null,
        clientExtensionResults: {},
      },
      expectedChallenge: input.expectedChallenge,
      expectedOrigin: input.origin,
      expectedRpId: input.rpId,
      credentialId: input.credentialId,
      publicKey: input.publicKey,
      counter: input.counter,
    });
    return { ok: true, newCounter: verified.newCounter };
  } catch {
    return { ok: false };
  }
};

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
  if (ingress && ingress.request_method === method && ingress.canonical_path === input.path) return ingress.gateway_session_digest;
  return undefined;
}

function parseBinding(body: unknown): { request_id: string; decision: OwnerInboxDecision; command_digest: string } | undefined {
  if (!record(body)) return undefined;
  const keys = Object.keys(body).sort();
  if (keys.join(",") !== "command_digest,decision,request_id,schema_version") return undefined;
  if (body.schema_version !== 1) return undefined;
  if (typeof body.request_id !== "string" || body.request_id.length === 0 || body.request_id.length > 256) return undefined;
  if (body.decision !== "approve" && body.decision !== "reject") return undefined;
  if (typeof body.command_digest !== "string" || !body.command_digest.startsWith("sha256:")) return undefined;
  return { request_id: body.request_id, decision: body.decision, command_digest: body.command_digest };
}

function parseDecide(body: unknown): {
  request_id: string;
  decision: OwnerInboxDecision;
  command_digest: string;
  challenge_id: string;
  assertion: InboxAssertion | undefined;
} | undefined {
  if (!record(body) || body.schema_version !== 1) return undefined;
  const binding = parseBinding({
    schema_version: 1,
    request_id: body.request_id,
    decision: body.decision,
    command_digest: body.command_digest,
  });
  if (binding === undefined || typeof body.challenge_id !== "string" || body.challenge_id.length === 0) return undefined;
  if (body.assertion === undefined) return { ...binding, challenge_id: body.challenge_id, assertion: undefined };
  if (!record(body.assertion)) return undefined;
  const assertion = body.assertion;
  if (typeof assertion.id !== "string" || typeof assertion.clientDataJSON !== "string"
    || typeof assertion.authenticatorData !== "string" || typeof assertion.signature !== "string"
    || typeof assertion.userHandle !== "string") return undefined;
  return {
    ...binding,
    challenge_id: body.challenge_id,
    assertion: {
      id: String(assertion.id),
      clientDataJSON: String(assertion.clientDataJSON),
      authenticatorData: String(assertion.authenticatorData),
      signature: String(assertion.signature),
      userHandle: String(assertion.userHandle),
    },
  };
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function statusFor(code: string): number | undefined {
  switch (code) {
    case "OWNER_INBOX_UNCONFIGURED": return 503;
    case "OWNER_INBOX_IDENTITY_REQUIRED":
    case "OWNER_INBOX_WEBAUTHN_REQUIRED":
    case "OWNER_INBOX_ASSERTION_REJECTED":
    case "OWNER_INBOX_REPLAY":
      return 401;
    case "OWNER_INBOX_ACTION_FORBIDDEN": return 403;
    case "OWNER_INBOX_INVALID": return 400;
    case "OWNER_INBOX_NOT_FOUND": return 404;
    case "OWNER_INBOX_NOT_PENDING":
    case "OWNER_INBOX_DIGEST_MISMATCH":
    case "OWNER_INBOX_EXPIRED":
    case "OWNER_INBOX_KEY_MISMATCH":
      return 409;
    default: return undefined;
  }
}

function methodError(input: { response: ServerResponse; requestId: string }): boolean {
  writeDashboardError(input.response, { status: 405, code: DASHBOARD_ERROR_CODES.VALIDATION_ERROR, requestId: input.requestId });
  return true;
}

function invalid(input: { response: ServerResponse; requestId: string }): boolean {
  writeDashboardError(input.response, { status: 400, code: DASHBOARD_ERROR_CODES.VALIDATION_ERROR, requestId: input.requestId });
  return true;
}

function coded(input: { response: ServerResponse; requestId: string }, status: number, code: typeof DASHBOARD_ERROR_CODES[keyof typeof DASHBOARD_ERROR_CODES]): boolean {
  writeDashboardError(input.response, { status, code, requestId: input.requestId });
  return true;
}

export function writePreflight(response: ServerResponse, origin: string): void {
  response.writeHead(204, {
    Allow: "GET, POST, OPTIONS",
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "content-type, x-jarvis-csrf",
    "Access-Control-Max-Age": "600",
  });
  response.end();
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
