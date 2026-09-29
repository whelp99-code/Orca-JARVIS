import { PHONE_GATEWAY_LIMITS, type PhoneRouteMatch } from "./phone-gateway-protocol.js";

export function knownRemoteMethods(path: string): readonly string[] | undefined {
  if (path === "/security") return ["GET"];
  if (path === "/api/v1/security/webauthn/credentials") return ["GET"];
  if (/^\/api\/v1\/remote-approvals\/[^/]+$/.test(path)) return ["GET"];
  if (/^\/api\/v1\/remote-approvals\/[^/]+\/options$/.test(path)) return ["POST"];
  if (/^\/api\/v1\/remote-approvals\/[^/]+\/verify$/.test(path)) return ["POST"];
  if (/^\/api\/v1\/remote-approvals\/[^/]+\/status$/.test(path)) return ["GET"];
  if (/^\/api\/v1\/security\/webauthn\/registrations\/[^/]+\/options$/.test(path)) return ["POST"];
  if (/^\/api\/v1\/security\/webauthn\/registrations\/[^/]+\/verify$/.test(path)) return ["POST"];
  return undefined;
}

export function matchRemotePhoneRoute(method: string, path: string, query: string): PhoneRouteMatch | undefined {
  if (query !== "") return undefined;
  const id = remoteId(path);
  if (id === undefined && path !== "/security" && path !== "/api/v1/security/webauthn/credentials") return undefined;
  if (path === "/security" && method === "GET") {
    return ok("security", "GET", path, PHONE_GATEWAY_LIMITS.html, true, false, false);
  }
  if (path === "/api/v1/security/webauthn/credentials" && method === "GET") {
    return ok("credential_read", "GET", path, PHONE_GATEWAY_LIMITS.jsonResponse, true, true, true);
  }
  if (id === undefined) return undefined;
  if (method === "GET" && path === `/api/v1/remote-approvals/${id}`) {
    return ok("remote_approval", "GET", path, PHONE_GATEWAY_LIMITS.jsonResponse, true, true, true);
  }
  if (method === "POST" && path === `/api/v1/remote-approvals/${id}/options`) {
    return ok("remote_approval", "POST", path, PHONE_GATEWAY_LIMITS.jsonResponse, true, true, true);
  }
  if (method === "POST" && path === `/api/v1/remote-approvals/${id}/verify`) {
    return ok("remote_approval", "POST", path, PHONE_GATEWAY_LIMITS.jsonResponse, true, true, true);
  }
  if (method === "GET" && path === `/api/v1/remote-approvals/${id}/status`) {
    return ok("remote_approval", "GET", path, PHONE_GATEWAY_LIMITS.jsonResponse, true, true, true);
  }
  if (method === "POST" && path === `/api/v1/security/webauthn/registrations/${id}/options`) {
    return ok("remote_approval", "POST", path, PHONE_GATEWAY_LIMITS.jsonResponse, true, true, true);
  }
  if (method === "POST" && path === `/api/v1/security/webauthn/registrations/${id}/verify`) {
    return ok("remote_approval", "POST", path, PHONE_GATEWAY_LIMITS.jsonResponse, true, true, true);
  }
  return undefined;
}

function remoteId(path: string): string | undefined {
  const match = /^\/api\/v1\/(?:remote-approvals|security\/webauthn\/registrations)\/([^/]+)/.exec(path);
  const id = match?.[1];
  if (id === undefined || id.length === 0 || id.length > 128 || !/^[A-Za-z0-9_-]+$/.test(id)) return undefined;
  return id;
}

function ok(
  routeClass: "security" | "remote_approval" | "credential_read",
  method: "GET" | "POST",
  path: string,
  responseCap: number,
  needsSession: boolean,
  needsCsrf: boolean,
  proxy: boolean,
): PhoneRouteMatch {
  return { kind: "ok", routeClass, method, path, query: "", responseCap, needsSession, needsCsrf, proxy };
}
