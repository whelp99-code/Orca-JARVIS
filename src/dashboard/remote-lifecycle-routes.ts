import type { IncomingMessage, ServerResponse } from "node:http";
import { JarvisError } from "../db.js";
import { parseReceiptDecision } from "./validation.js";
import {
  activateCredential,
  beginEnrollment,
  listCredentials,
  revokeCredential,
  revokePrincipal,
  stageCredentialRevoke,
  stagePrincipalRevoke,
} from "../remote-approval-lifecycle.js";
import { RemoteApprovalError, remoteErrorBody, REMOTE_ERROR_CODES } from "../remote-approval-errors.js";
import { parseReasonBody, parseSchemaBody } from "../remote-approval-parse.js";
import type { RemoteApprovalService } from "../remote-approval.js";
import { DASHBOARD_ERROR_CODES, writeDashboardError, writeDashboardJson } from "./http.js";
import { hasExactMutationOrigin, readJsonPost, writePostBoundaryError } from "./request-boundary.js";
import { sessionMatchesCsrf, type DashboardSessionStore } from "./session.js";

export type RemoteLifecycleRouteInput = {
  readonly service: RemoteApprovalService;
  readonly path: string;
  readonly request: IncomingMessage;
  readonly response: ServerResponse;
  readonly requestId: string;
  readonly session: DashboardSessionStore;
  readonly origin: string;
  readonly clock: () => Date;
};

type LifecycleMatch =
  | { readonly kind: "unhandled" }
  | { readonly kind: "invalid" }
  | { readonly kind: "enroll" }
  | { readonly kind: "list" }
  | { readonly kind: "activate"; readonly credentialId: string }
  | { readonly kind: "revoke_request"; readonly credentialId: string }
  | { readonly kind: "revoke"; readonly credentialId: string }
  | { readonly kind: "principal_revoke_request" }
  | { readonly kind: "principal_revoke" };

export async function tryHandleRemoteLifecycleRoutes(input: RemoteLifecycleRouteInput): Promise<boolean> {
  const match = matchLifecycle(input.path);
  if (match.kind === "unhandled") return false;
  if (match.kind === "invalid") {
    writeLifecycleError(input, new RemoteApprovalError(REMOTE_ERROR_CODES.REMOTE_REQUEST_INVALID, "path"));
    return true;
  }
  try {
    if (input.request.method === "GET") {
      if (match.kind !== "list") throw new RemoteApprovalError(REMOTE_ERROR_CODES.REMOTE_REQUEST_INVALID, "method");
      requireLocalSession(input);
      writeDashboardJson(input.response, {
        status: 200, requestId: input.requestId, body: listCredentials(input.service),
      });
      return true;
    }
    if (input.request.method !== "POST") {
      throw new RemoteApprovalError(REMOTE_ERROR_CODES.REMOTE_REQUEST_INVALID, "method");
    }
    const parsed = await readJsonPost({
      request: input.request, session: input.session, origin: input.origin, path: input.path,
    });
    if (parsed.kind === "rejected") {
      writePostBoundaryError(input.response, input.requestId, parsed);
      return true;
    }
    await handlePost(input, match, parsed.value);
    return true;
  } catch (error) {
    if (error instanceof RemoteApprovalError) {
      writeLifecycleError(input, error);
      return true;
    }
    if (error instanceof JarvisError) {
      writeLifecycleError(input, new RemoteApprovalError(REMOTE_ERROR_CODES.REMOTE_REQUEST_INVALID, error.code));
      return true;
    }
    throw error;
  }
}

function matchLifecycle(path: string): LifecycleMatch {
  if (path === "/api/v1/security/webauthn/enrollments") return { kind: "enroll" };
  if (path === "/api/v1/security/webauthn/credentials") return { kind: "list" };
  if (path === "/api/v1/security/remote-principal/revocation-requests") return { kind: "principal_revoke_request" };
  if (path === "/api/v1/security/remote-principal/revoke") return { kind: "principal_revoke" };
  const credPrefix = "/api/v1/security/webauthn/credentials/";
  if (!path.startsWith(credPrefix)) return { kind: "unhandled" };
  const rest = path.slice(credPrefix.length);
  if (rest.includes("%") || rest.includes("//")) return { kind: "invalid" };
  const activate = rest.match(/^([^/]+)\/activate$/);
  if (activate?.[1]) return { kind: "activate", credentialId: activate[1] };
  const revokeReq = rest.match(/^([^/]+)\/revocation-requests$/);
  if (revokeReq?.[1]) return { kind: "revoke_request", credentialId: revokeReq[1] };
  const revoke = rest.match(/^([^/]+)\/revoke$/);
  if (revoke?.[1]) return { kind: "revoke", credentialId: revoke[1] };
  return { kind: "unhandled" };
}

async function handlePost(
  input: RemoteLifecycleRouteInput,
  match: Exclude<LifecycleMatch, { kind: "unhandled" | "invalid" }>,
  body: unknown,
): Promise<void> {
  const now = input.clock();
  switch (match.kind) {
    case "enroll":
      parseSchemaBody(body);
      writeDashboardJson(input.response, {
        status: 200, requestId: input.requestId, body: beginEnrollment(input.service, now),
      });
      return;
    case "list":
      throw new RemoteApprovalError(REMOTE_ERROR_CODES.REMOTE_REQUEST_INVALID, "method");
    case "activate":
      writeDashboardJson(input.response, {
        status: 200, requestId: input.requestId,
        body: activateCredential(input.service, match.credentialId, parseReceiptDecision(body).receipt, now),
      });
      return;
    case "revoke_request":
      writeDashboardJson(input.response, {
        status: 200, requestId: input.requestId,
        body: stageCredentialRevoke(input.service, match.credentialId, parseReasonBody(body), now),
      });
      return;
    case "revoke":
      writeDashboardJson(input.response, {
        status: 200, requestId: input.requestId,
        body: revokeCredential(input.service, match.credentialId, parseReceiptDecision(body).receipt, now),
      });
      return;
    case "principal_revoke_request":
      writeDashboardJson(input.response, {
        status: 200, requestId: input.requestId,
        body: stagePrincipalRevoke(input.service, parseReasonBody(body), now),
      });
      return;
    case "principal_revoke":
      writeDashboardJson(input.response, {
        status: 200, requestId: input.requestId,
        body: revokePrincipal(input.service, parseReceiptDecision(body).receipt, now),
      });
      return;
    default:
      return assertNever(match);
  }
}

function requireLocalSession(input: RemoteLifecycleRouteInput): void {
  const csrf = typeof input.request.headers["x-jarvis-csrf"] === "string" ? input.request.headers["x-jarvis-csrf"] : undefined;
  if (!hasExactMutationOrigin(input.request, input.origin) || !sessionMatchesCsrf(input.session, csrf)) {
    writeDashboardError(input.response, {
      status: 403, code: DASHBOARD_ERROR_CODES.LOCAL_SESSION_REQUIRED, requestId: input.requestId,
    });
    throw new RemoteApprovalError(REMOTE_ERROR_CODES.REMOTE_SESSION_REQUIRED, "local");
  }
}

function writeLifecycleError(input: RemoteLifecycleRouteInput, error: RemoteApprovalError): void {
  if (input.response.headersSent) return;
  writeDashboardJson(input.response, {
    status: error.status, requestId: input.requestId, body: remoteErrorBody(error.code, input.requestId),
  });
}

function assertNever(value: never): never {
  throw new Error(`unexpected lifecycle route ${JSON.stringify(value)}`);
}
