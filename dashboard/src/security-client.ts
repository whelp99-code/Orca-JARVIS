import type { SecurityClient, SecurityCredential } from "./pages/security-page.js";
import { assertPasskey, createPasskey, gatewayOrigin } from "./webauthn-ceremony.js";

/** Phone origin: the gateway session token. Local origin: the loopback dashboard session token. */
async function fetchCsrfToken(): Promise<string> {
  const response = await fetch(gatewayOrigin() ? "/api/v1/phone/session" : "/api/v1/session");
  const parsed = await response.json() as { csrf_token?: string };
  if (!response.ok || parsed.csrf_token === undefined) throw new Error("Remote approval unavailable");
  return parsed.csrf_token;
}

export function createBrowserSecurityClient(): SecurityClient {
  let token: Promise<string> | undefined;
  const csrfToken = (): Promise<string> => {
    token ??= fetchCsrfToken().catch((error: unknown) => { token = undefined; throw error; });
    return token;
  };
  async function jsonFetch(path: string, init?: RequestInit): Promise<Record<string, unknown>> {
    const headers = new Headers(init?.headers);
    if (init?.body !== undefined && !headers.has("content-type")) headers.set("content-type", "application/json; charset=utf-8");
    headers.set("x-jarvis-csrf", await csrfToken());
    const response = await fetch(path, { ...init, headers });
    const body = await response.json() as Record<string, unknown> & { error?: { message?: string } };
    if (!response.ok) throw new Error(body.error?.message ?? "Remote approval unavailable");
    return body;
  }
  const jsonPost = (path: string, body: unknown): Promise<Record<string, unknown>> =>
    jsonFetch(path, { method: "POST", body: JSON.stringify(body) });
  return {
    async listCredentials() {
      const body = await jsonFetch("/api/v1/security/webauthn/credentials");
      if (!Array.isArray(body.items)) throw new Error("Remote approval unavailable");
      return { items: body.items as SecurityCredential[] };
    },
    async beginEnrollment() {
      const body = await jsonPost("/api/v1/security/webauthn/enrollments", { schema_version: 1 });
      if (typeof body.enrollment_id !== "string") throw new Error("Remote approval unavailable");
      return { enrollment_id: body.enrollment_id, request_id: typeof body.request_id === "string" ? body.request_id : undefined };
    },
    async registerPasskey(enrollmentId, beginRequestId) {
      const options = await jsonPost(`/api/v1/security/webauthn/registrations/${encodeURIComponent(enrollmentId)}/options`, {
        schema_version: 1, begin_request_id: beginRequestId,
      });
      const publicKey = options.options;
      if (typeof publicKey !== "object" || publicKey === null) throw new Error("Remote approval unavailable");
      const credential = await createPasskey(publicKey as Record<string, unknown>);
      const ceremonyId = String(options.ceremony_id);
      const verified = await jsonPost(`/api/v1/security/webauthn/registrations/${encodeURIComponent(ceremonyId)}/verify`, {
        schema_version: 1, credential,
      });
      return { credential_id: String(verified.credential_id), activation_request_id: String(verified.activation_request_id) };
    },
    async stageRevocation(credentialId) {
      const body = await jsonPost(`/api/v1/security/webauthn/credentials/${encodeURIComponent(credentialId)}/revocation-requests`, {
        schema_version: 1, reason: "owner",
      });
      if (typeof body.request_id !== "string") throw new Error("Remote approval unavailable");
      return { request_id: body.request_id };
    },
    async loadRequest(requestId) {
      const loaded = await jsonFetch(`/api/v1/remote-approvals/${encodeURIComponent(requestId)}`);
      return loaded as Awaited<ReturnType<SecurityClient["loadRequest"]>>;
    },
    async decideRemote(requestId, decision) {
      const issued = await jsonPost(`/api/v1/remote-approvals/${encodeURIComponent(requestId)}/options`, {
        schema_version: 1, decision,
      });
      const challengeId = String(issued.challenge_id);
      const options = issued.options;
      if (typeof options !== "object" || options === null) throw new Error("Remote approval unavailable");
      const credential = await assertPasskey(options as Record<string, unknown>);
      const verified = await jsonPost(`/api/v1/remote-approvals/${encodeURIComponent(challengeId)}/verify`, {
        schema_version: 1, credential,
      });
      const status = await jsonFetch(`/api/v1/remote-approvals/${encodeURIComponent(challengeId)}/status`);
      return {
        challenge_id: challengeId,
        outcome: String(status.state),
        receipt_id: typeof verified.receipt_id === "string" ? verified.receipt_id : undefined,
      };
    },
  };
}
