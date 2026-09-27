import type { SecurityClient, SecurityCredential } from "./pages/security-page.js";
import { assertPasskey, createPasskey } from "./webauthn-ceremony.js";

let phoneToken: string | undefined;

async function phoneCsrf(): Promise<string | undefined> {
  if (document.querySelector("meta[name='jarvis-phone-mode']") === null) return undefined;
  if (phoneToken !== undefined) return phoneToken;
  const session = await fetch("/api/v1/phone/session");
  if (!session.ok) return undefined;
  const parsed = await session.json() as { csrf_token?: string };
  phoneToken = parsed.csrf_token;
  return phoneToken;
}

async function jsonFetch(path: string, init?: RequestInit): Promise<{ readonly ok: boolean; readonly body: Record<string, unknown> }> {
  const headers = new Headers(init?.headers);
  if (init?.body !== undefined && !headers.has("content-type")) headers.set("content-type", "application/json; charset=utf-8");
  const token = await phoneCsrf();
  if (token !== undefined) headers.set("x-jarvis-csrf", token);
  const response = await fetch(path, { ...init, headers });
  const body = await response.json() as Record<string, unknown> & { error?: { message?: string } };
  if (!response.ok) throw new Error(body.error?.message ?? "Remote approval unavailable");
  return { ok: true, body };
}

export function createBrowserSecurityClient(): SecurityClient {
  return {
    async listCredentials() {
      const session = await (await fetch("/api/v1/session")).json() as { csrf_token?: string };
      const response = await fetch("/api/v1/security/webauthn/credentials", {
        headers: session.csrf_token === undefined ? {} : { "x-jarvis-csrf": session.csrf_token },
      });
      const body = await response.json() as { items?: SecurityCredential[]; error?: { message: string } };
      if (!response.ok || body.items === undefined) throw new Error(body.error?.message ?? "Remote approval unavailable");
      return { items: body.items };
    },
    async beginEnrollment() {
      const session = await (await fetch("/api/v1/session")).json() as { csrf_token: string };
      const response = await fetch("/api/v1/security/webauthn/enrollments", {
        method: "POST",
        headers: { "content-type": "application/json; charset=utf-8", "x-jarvis-csrf": session.csrf_token },
        body: JSON.stringify({ schema_version: 1 }),
      });
      const body = await response.json() as { enrollment_id?: string; request_id?: string; error?: { message: string } };
      if (!response.ok || body.enrollment_id === undefined) throw new Error(body.error?.message ?? "Remote approval unavailable");
      return { enrollment_id: body.enrollment_id, request_id: body.request_id };
    },
    async registerPasskey(enrollmentId, beginRequestId) {
      const options = await jsonFetch(`/api/v1/security/webauthn/registrations/${encodeURIComponent(enrollmentId)}/options`, {
        method: "POST",
        body: JSON.stringify({ schema_version: 1, begin_request_id: beginRequestId }),
      });
      const publicKey = options.body.options;
      if (typeof publicKey !== "object" || publicKey === null) throw new Error("Remote approval unavailable");
      const credential = await createPasskey(publicKey as Record<string, unknown>);
      const ceremonyId = String(options.body.ceremony_id);
      const verified = await jsonFetch(`/api/v1/security/webauthn/registrations/${encodeURIComponent(ceremonyId)}/verify`, {
        method: "POST",
        body: JSON.stringify({ schema_version: 1, credential }),
      });
      return { credential_id: String(verified.body.credential_id), activation_request_id: String(verified.body.activation_request_id) };
    },
    async stageRevocation(credentialId) {
      const session = await (await fetch("/api/v1/session")).json() as { csrf_token: string };
      const response = await fetch(`/api/v1/security/webauthn/credentials/${encodeURIComponent(credentialId)}/revocation-requests`, {
        method: "POST",
        headers: { "content-type": "application/json; charset=utf-8", "x-jarvis-csrf": session.csrf_token },
        body: JSON.stringify({ schema_version: 1, reason: "owner" }),
      });
      const body = await response.json() as { request_id?: string; error?: { message: string } };
      if (!response.ok || body.request_id === undefined) throw new Error(body.error?.message ?? "Remote approval unavailable");
      return { request_id: body.request_id };
    },
    async loadRequest(requestId) {
      const loaded = await jsonFetch(`/api/v1/remote-approvals/${encodeURIComponent(requestId)}`);
      return loaded.body as Awaited<ReturnType<SecurityClient["loadRequest"]>>;
    },
    async decideRemote(requestId, decision) {
      const issued = await jsonFetch(`/api/v1/remote-approvals/${encodeURIComponent(requestId)}/options`, {
        method: "POST",
        body: JSON.stringify({ schema_version: 1, decision }),
      });
      const challengeId = String(issued.body.challenge_id);
      const options = issued.body.options;
      if (typeof options !== "object" || options === null) throw new Error("Remote approval unavailable");
      const credential = await assertPasskey(options as Record<string, unknown>);
      const verified = await jsonFetch(`/api/v1/remote-approvals/${encodeURIComponent(challengeId)}/verify`, {
        method: "POST",
        body: JSON.stringify({ schema_version: 1, credential }),
      });
      const status = await jsonFetch(`/api/v1/remote-approvals/${encodeURIComponent(challengeId)}/status`);
      return {
        challenge_id: challengeId,
        outcome: String(status.body.state),
        receipt_id: typeof verified.body.receipt_id === "string" ? verified.body.receipt_id : undefined,
      };
    },
  };
}
