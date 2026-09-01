import type { IncomingMessage, ServerResponse } from "node:http";
import { parseSecondBrainStrictJsonBytes } from "../second-brain-strict-json.js";
import { RemoteApprovalError, remoteErrorBody, REMOTE_ERROR_CODES } from "../remote-approval-errors.js";
import type { RemoteApprovalService } from "../remote-approval.js";
import { issueRegistrationOptions, verifyRegistration } from "../remote-approval-registration.js";
import type { RemoteIngressContextV1 } from "../remote-approval-types.js";
import { hasExactMutationOrigin } from "./request-boundary.js";
import { sessionMatchesCsrf, type DashboardSessionStore } from "./session.js";
import { writeDashboardJson } from "./http.js";

const MAX_BODY = 64 * 1024;
const CSRF = "x-jarvis-csrf";

export type RemoteAuthRouteInput = {
  readonly service: RemoteApprovalService;
  readonly path: string;
  readonly request: IncomingMessage;
  readonly response: ServerResponse;
  readonly requestId: string;
  readonly session: DashboardSessionStore;
  readonly origin: string;
  readonly clock: () => Date;
};

export async function tryHandleRemoteAuthRoutes(input: RemoteAuthRouteInput): Promise<boolean> {
  const remote = matchRemotePath(input.path);
  if (remote.kind === "unhandled") return false;
  if (remote.kind === "invalid") {
    writeRemoteError(input, new RemoteApprovalError(REMOTE_ERROR_CODES.REMOTE_REQUEST_INVALID, "path"));
    return true;
  }
  try {
    if (input.request.method === "GET") {
      await handleRemoteGet(input, remote);
      return true;
    }
    if (input.request.method === "POST") {
      await handleRemotePost(input, remote);
      return true;
    }
    writeRemoteError(input, new RemoteApprovalError(REMOTE_ERROR_CODES.REMOTE_REQUEST_INVALID, "method"));
    return true;
  } catch (error) {
    if (error instanceof RemoteApprovalError) {
      writeRemoteError(input, error);
      return true;
    }
    throw error;
  }
}

type RemoteMatch =
  | { readonly kind: "unhandled" }
  | { readonly kind: "invalid" }
  | { readonly kind: "review"; readonly requestId: string }
  | { readonly kind: "options"; readonly requestId: string }
  | { readonly kind: "verify"; readonly challengeId: string }
  | { readonly kind: "status"; readonly challengeId: string }
  | { readonly kind: "reg_options"; readonly enrollmentId: string }
  | { readonly kind: "reg_verify"; readonly ceremonyId: string };

function matchRemotePath(path: string): RemoteMatch {
  const remote = matchRemote(path);
  if (remote.kind !== "unhandled") return remote;
  return matchRegistration(path);
}

function matchRemote(path: string): RemoteMatch {
  const prefix = "/api/v1/remote-approvals/";
  if (!path.startsWith(prefix)) return { kind: "unhandled" };
  const rest = path.slice(prefix.length);
  if (rest.includes("%") || rest.includes("//")) return { kind: "invalid" };
  const options = rest.match(/^([^/]+)\/options$/);
  if (options?.[1]) return { kind: "options", requestId: options[1] };
  const verify = rest.match(/^([^/]+)\/verify$/);
  if (verify?.[1]) return { kind: "verify", challengeId: verify[1] };
  const status = rest.match(/^([^/]+)\/status$/);
  if (status?.[1]) return { kind: "status", challengeId: status[1] };
  if (!rest.includes("/")) return { kind: "review", requestId: rest };
  return { kind: "invalid" };
}

function matchRegistration(path: string): RemoteMatch {
  const prefix = "/api/v1/security/webauthn/registrations/";
  if (!path.startsWith(prefix)) return { kind: "unhandled" };
  const rest = path.slice(prefix.length);
  if (rest.includes("%") || rest.includes("//")) return { kind: "invalid" };
  const options = rest.match(/^([^/]+)\/options$/);
  if (options?.[1]) return { kind: "reg_options", enrollmentId: options[1] };
  const verify = rest.match(/^([^/]+)\/verify$/);
  if (verify?.[1]) return { kind: "reg_verify", ceremonyId: verify[1] };
  return { kind: "invalid" };
}

async function handleRemoteGet(input: RemoteAuthRouteInput, remote: Exclude<RemoteMatch, { kind: "unhandled" | "invalid" }>): Promise<void> {
  const body = Buffer.alloc(0);
  const ingress = admit(input, body, "GET", input.path);
  switch (remote.kind) {
    case "review":
      writeDashboardJson(input.response, {
        status: 200, requestId: input.requestId, body: input.service.projectRequest(remote.requestId, ingress, input.clock()),
      });
      return;
    case "status":
      writeDashboardJson(input.response, {
        status: 200, requestId: input.requestId, body: input.service.status(remote.challengeId, ingress, input.clock()),
      });
      return;
    case "options":
    case "verify":
    case "reg_options":
    case "reg_verify":
      throw new RemoteApprovalError(REMOTE_ERROR_CODES.REMOTE_REQUEST_INVALID, "method");
    default:
      return assertNever(remote);
  }
}

async function handleRemotePost(input: RemoteAuthRouteInput, remote: Exclude<RemoteMatch, { kind: "unhandled" | "invalid" }>): Promise<void> {
  const raw = await readBody(input.request);
  const ingress = admit(input, raw, "POST", input.path);
  switch (remote.kind) {
    case "options": {
      const parsed = parseSecondBrainStrictJsonBytes(raw);
      if (parsed === undefined) throw new RemoteApprovalError(REMOTE_ERROR_CODES.REMOTE_REQUEST_INVALID, "json");
      const issued = input.service.issueOptions(remote.requestId, parsed, ingress, input.clock());
      writeDashboardJson(input.response, { status: 200, requestId: input.requestId, body: { schema_version: 1, ...issued } });
      return;
    }
    case "verify": {
      const verified = await input.service.verify(remote.challengeId, raw, ingress, input.clock());
      writeDashboardJson(input.response, { status: 200, requestId: input.requestId, body: { schema_version: 1, ...verified } });
      return;
    }
    case "reg_options": {
      const parsed = parseSecondBrainStrictJsonBytes(raw);
      if (parsed === undefined) throw new RemoteApprovalError(REMOTE_ERROR_CODES.REMOTE_REQUEST_INVALID, "json");
      const issued = issueRegistrationOptions(input.service, remote.enrollmentId, parsed, ingress, input.clock());
      writeDashboardJson(input.response, { status: 200, requestId: input.requestId, body: issued });
      return;
    }
    case "reg_verify": {
      const verified = await verifyRegistration(input.service, remote.ceremonyId, raw, ingress, input.clock());
      writeDashboardJson(input.response, { status: 200, requestId: input.requestId, body: verified });
      return;
    }
    case "review":
    case "status":
      throw new RemoteApprovalError(REMOTE_ERROR_CODES.REMOTE_REQUEST_INVALID, "method");
    default:
      return assertNever(remote);
  }
}

function admit(input: RemoteAuthRouteInput, body: Buffer, method: "GET" | "POST", path: string): RemoteIngressContextV1 {
  const csrf = header(input.request.headers[CSRF]);
  const local = hasExactMutationOrigin(input.request, input.origin) && sessionMatchesCsrf(input.session, csrf);
  const ingress = input.service.resolver(input.request, body);
  if (local && ingress) throw new RemoteApprovalError(REMOTE_ERROR_CODES.REMOTE_REQUEST_INVALID, "ambiguous");
  if (!ingress) throw new RemoteApprovalError(REMOTE_ERROR_CODES.REMOTE_SESSION_REQUIRED, "ingress");
  if (ingress.request_method !== method || ingress.canonical_path !== path) {
    throw new RemoteApprovalError(REMOTE_ERROR_CODES.REMOTE_SESSION_REQUIRED, "path");
  }
  return ingress;
}

async function readBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const piece = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    size += piece.byteLength;
    if (size > MAX_BODY) {
      request.destroy();
      throw new RemoteApprovalError(REMOTE_ERROR_CODES.REMOTE_REQUEST_INVALID, "too_large");
    }
    chunks.push(piece);
  }
  return Buffer.concat(chunks, size);
}

function header(value: string | readonly string[] | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function writeRemoteError(input: RemoteAuthRouteInput, error: RemoteApprovalError): void {
  writeDashboardJson(input.response, {
    status: error.status, requestId: input.requestId, body: remoteErrorBody(error.code, input.requestId),
  });
}

function assertNever(value: never): never {
  throw new Error(`unexpected remote route ${JSON.stringify(value)}`);
}
