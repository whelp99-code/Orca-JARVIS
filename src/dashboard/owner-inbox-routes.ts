import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { JarvisError, type AuthorityDb } from "../db.js";
import { enrollOwnerPasskey, readEnrollmentChallenge, rejectEnrollmentOrigin, type EnrollmentCheck } from "../owner-inbox-enrollment.js";
import { writeOwnerInboxPreflight } from "../owner-inbox-preflight.js";
import { ApprovedCommandExecutor, approvedActionHasExecutor } from "../approved-executor.js";
import { ControlPlane } from "../control-plane.js";
import { OwnerInbox, type AssertionCheck, type InboxAssertion, type OwnerInboxDecision } from "../owner-inbox.js";
import type { DashboardExecutorFactory } from "./authority-service.js";
import type { MemoryLifecycleService } from "../memory-lifecycle-service-types.js";
import { composeOwnerInbox } from "../remote-approval-compose.js";
import { verifyAssertionCrypto } from "../remote-approval-webauthn.js";
import type { RemoteApprovalService } from "../remote-approval.js";
import { DASHBOARD_ERROR_CODES, writeDashboardError, writeDashboardJson } from "./http.js";
import { hasExactMutationOrigin, hasSameOriginReadOrigin } from "./request-boundary.js";
import { sessionMatchesCsrf, type DashboardSessionStore } from "./session.js";
import { parseSecondBrainStrictJsonBytes } from "../second-brain-strict-json.js";

const CSRF = "x-jarvis-csrf";
const MAX_BODY = 16_384;
const PATHS = new Set([
  "/api/v1/owner-inbox", "/api/v1/owner-inbox/decide", "/api/v1/owner-inbox/challenge", "/api/v1/owner-inbox/enroll",
]);

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
  enrollmentCheck?: EnrollmentCheck;
  now?: Date;
  executorFactory?: DashboardExecutorFactory;
  memoryLifecycle?: Pick<MemoryLifecycleService, "execute">;
  clock?: () => Date;
}>): Promise<boolean> {
  if (!PATHS.has(input.path)) return false;
  const method = input.request.method ?? "";
  if (method === "OPTIONS") {
    writeOwnerInboxPreflight(input.response, input.origin);
    return true;
  }
  if (input.path === "/api/v1/owner-inbox" && method !== "GET") return methodError(input);
  if (input.path !== "/api/v1/owner-inbox" && method !== "POST") return methodError(input);
  const raw = method === "POST" ? await readBody(input.request) : Buffer.alloc(0);
  if (raw === undefined) return invalid(input);
  const admitted = admit(input, raw, method === "POST" ? "POST" : "GET");
  if (admitted === undefined) return coded(input, 401, DASHBOARD_ERROR_CODES.OWNER_INBOX_IDENTITY_REQUIRED);
  const sessionId = admitted.id;
  const inbox = input.ownerInbox ?? composeOwnerInbox(input.db);
  try {
    if (method === "GET") {
      const enrolled = input.db.db.prepare("SELECT COUNT(*) AS n FROM owner_inbox_credentials").get() as { n: number };
      writeDashboardJson(input.response, {
        status: 200, requestId: input.requestId,
        body: { schema_version: 1, items: inbox.list(), passkey_enrolled: enrolled.n > 0 },
      });
      return true;
    }
    const body = parseSecondBrainStrictJsonBytes(raw);
    const ceremony = ceremonyOrigin(input, admitted);
    if (input.path.endsWith("/enroll")) {
      const enrolled = await enrollFrom(input, body, ceremony);
      writeDashboardJson(input.response, { status: 200, requestId: input.requestId, body: { schema_version: 1, ...enrolled } });
      return true;
    }
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
      origin: ceremony.origin,
      rpId: ceremony.rpId,
    });
    const execution = result.state === "approved"
      ? await executeApprovedInbox(input, result.request_id, result.carried?.carried === true ? result.carried.request_id : undefined)
      : undefined;
    writeDashboardJson(input.response, { status: 200, requestId: input.requestId, body: { schema_version: 1, ...result, execution: execution === undefined ? undefined : redactExecution(execution) } });
  } catch (error) {
    if (!(error instanceof JarvisError)) throw error;
    const status = statusFor(error.code);
    if (status === undefined) throw error;
    const code = error.code as typeof DASHBOARD_ERROR_CODES[keyof typeof DASHBOARD_ERROR_CODES];
    writeDashboardError(input.response, { status, code, requestId: input.requestId });
  }
  return true;
}

async function executeApprovedInbox(input: Readonly<{
  db: AuthorityDb;
  now?: Date;
  clock?: () => Date;
  executorFactory?: DashboardExecutorFactory;
  memoryLifecycle?: Pick<MemoryLifecycleService, "execute">;
}>, requestId: string, carriedRequestId?: string): Promise<unknown> {
  const now = input.now ?? input.clock?.() ?? new Date();
  const executor = input.executorFactory?.({ db: input.db, now, memoryLifecycle: input.memoryLifecycle })
    ?? new ApprovedCommandExecutor(input.db, undefined, undefined, {}, () => now, undefined, undefined, input.memoryLifecycle);
  const run = async (id: string) => {
    const row = input.db.db.prepare("SELECT action FROM control_command_requests WHERE request_id = ?")
      .get(id) as { action: string } | undefined;
    if (row === undefined || !approvedActionHasExecutor(row.action)) {
      return { request_id: id, state: "approved" as const, manual_wait: true as const };
    }
    try {
      // One claim. An uncertain result is returned as-is and is not claimed again.
      const executed = await executor.execute(id, "owner-inbox", now);
      persistUnsettled(input.db, id, executed.state, executed.failure_code, now);
      return executed;
    } catch (error) {
      return { request_id: id, state: "failed" as const,
        failure_code: error instanceof JarvisError ? error.code : "APPROVED_COMMAND_FAILED" };
    }
  };
  const primary = await run(requestId);
  const carried = carriedRequestId === undefined ? undefined : await run(carriedRequestId);
  return carried === undefined ? primary : { primary, carried };
}

function persistUnsettled(db: AuthorityDb, requestId: string, state: string, failureCode: string | undefined, now: Date): void {
  if (state !== "failed" && state !== "uncertain") return;
  const row = db.db.prepare("SELECT state, lease_fence FROM control_command_requests WHERE request_id = ?")
    .get(requestId) as { state: string; lease_fence: number } | undefined;
  if (row?.state !== "claimed") return;
  const code = failureCode && failureCode.length > 0 ? failureCode : "APPROVED_COMMAND_FAILED";
  new ControlPlane(db).settle(requestId, row.lease_fence, {
    state, effect_type: state === "uncertain" ? "command.uncertain" : "command.failure",
    payload: { code }, failure_code: code,
  }, now);
}

export function redactExecution(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { state: "failed", failure_code: "APPROVED_COMMAND_FAILED" };
  }
  const row = value as Record<string, unknown>;
  if ("primary" in row || "carried" in row) {
    return {
      primary: redactExecution(row.primary),
      ...(row.carried === undefined ? {} : { carried: redactExecution(row.carried) }),
    };
  }
  const failure = typeof row.failure_code === "string" && row.failure_code.length > 0 ? row.failure_code : undefined;
  return {
    request_id: typeof row.request_id === "string" ? row.request_id : undefined,
    state: typeof row.state === "string" ? row.state : "failed",
    ...(row.manual_wait === true ? { manual_wait: true } : {}),
    ...(failure ? { failure_code: failure } : {}),
  };
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

type Admission = { readonly id: string; readonly publicOrigin?: string };

function admit(input: {
  request: IncomingMessage;
  origin: string;
  session: DashboardSessionStore;
  remoteApproval?: RemoteApprovalService;
  path: string;
}, body: Buffer, method: "GET" | "POST"): Admission | undefined {
  const csrf = header(input.request.headers[CSRF]);
  const sameOrigin = method === "GET"
    ? hasSameOriginReadOrigin(input.request, input.origin)
    : hasExactMutationOrigin(input.request, input.origin);
  const local = sameOrigin && sessionMatchesCsrf(input.session, csrf);
  const ingress = input.remoteApproval?.resolver(input.request, body) ?? null;
  if (local && ingress) return undefined;
  if (local && csrf !== undefined) return { id: `local:${createHash("sha256").update(csrf).digest("hex")}` };
  if (ingress && ingress.request_method === method && ingress.canonical_path === input.path) {
    return { id: ingress.gateway_session_digest, publicOrigin: ingress.public_origin };
  }
  return undefined;
}

function ceremonyOrigin(input: {
  request: IncomingMessage;
  db: AuthorityDb;
  origin: string;
  now?: Date;
}, admitted: Admission): { readonly origin: string; readonly rpId: string } {
  if (admitted.publicOrigin !== undefined) {
    return { origin: admitted.publicOrigin, rpId: new URL(admitted.publicOrigin).hostname };
  }
  const expected = process.env.JARVIS_OWNER_INBOX_ORIGIN ?? input.origin;
  const sent = header(input.request.headers.origin) ?? input.origin;
  if (sent !== expected) rejectEnrollmentOrigin(input.db, input.now ?? new Date());
  return { origin: expected, rpId: new URL(expected).hostname };
}

async function enrollFrom(input: {
  db: AuthorityDb;
  enrollmentCheck?: EnrollmentCheck;
  now?: Date;
}, body: unknown, ceremony: { readonly origin: string; readonly rpId: string }): Promise<{ credential_id: string } | EnrollmentOptions> {
  if (!record(body) || body.schema_version !== 1 || typeof body.enrollment_code !== "string" || body.enrollment_code.length === 0) {
    throw new JarvisError("OWNER_INBOX_INVALID");
  }
  if (body.phase === "options") {
    const challenge = readEnrollmentChallenge(input.db, body.enrollment_code, input.now);
    return registrationOptions(challenge, ceremony.rpId);
  }
  if (!record(body.attestation)) throw new JarvisError("OWNER_INBOX_WEBAUTHN_REQUIRED");
  const attestation = body.attestation;
  return enrollOwnerPasskey(input.db, {
    code: body.enrollment_code,
    attestation: {
      id: String(attestation.id ?? ""),
      clientDataJSON: String(attestation.clientDataJSON ?? ""),
      attestationObject: String(attestation.attestationObject ?? ""),
    },
    origin: ceremony.origin,
    expectedOrigin: ceremony.origin,
    rpId: ceremony.rpId,
    check: input.enrollmentCheck,
    now: input.now,
  });
}

type EnrollmentOptions = {
  readonly phase: "options";
  readonly challenge: string;
  readonly rp: { readonly id: string; readonly name: string };
  readonly user: { readonly id: string; readonly name: string; readonly displayName: string };
  readonly pubKeyCredParams: readonly { readonly type: "public-key"; readonly alg: -7 | -8 }[];
  readonly timeout: number;
  readonly attestation: "none";
  readonly authenticatorSelection: { readonly residentKey: "required"; readonly userVerification: "required" };
};

function registrationOptions(challenge: string, rpId: string): EnrollmentOptions {
  return {
    phase: "options",
    challenge,
    rp: { id: rpId, name: "JARVIS" },
    user: { id: "amFydmlzLW93bmVy", name: "owner", displayName: "소유자" },
    pubKeyCredParams: [{ type: "public-key", alg: -7 }, { type: "public-key", alg: -8 }],
    timeout: 60_000,
    attestation: "none",
    authenticatorSelection: { residentKey: "required", userVerification: "required" },
  };
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
    case "OWNER_INBOX_ORIGIN_MISMATCH":
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

function coded(
  input: { response: ServerResponse; requestId: string },
  status: number,
  code: typeof DASHBOARD_ERROR_CODES[keyof typeof DASHBOARD_ERROR_CODES],
): boolean {
  writeDashboardError(input.response, { status, code, requestId: input.requestId });
  return true;
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
