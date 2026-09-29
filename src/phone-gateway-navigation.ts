import { PHONE_COOKIE_NAME } from "./dashboard/phone-session.js";
import { headerValues } from "./phone-gateway-config.js";
import { writePhoneGatewayError } from "./phone-gateway-http.js";
import { PHONE_ERROR_CODES } from "./phone-gateway-protocol.js";
import type { DispatchUpdate, PhoneGatewayRequestCtx } from "./phone-gateway-request-ctx.js";

/**
 * A browser reaches the SPA by navigating, and a navigation carries no CSRF token
 * and no prior cookie. For a document route only, an HTML navigation from the
 * verified owner mints a session through the same issuance path as the session
 * route (already pre-session rate-limited). Every other unauthenticated request
 * stays 401.
 */
export function bootstrapDocumentSession(
  ctx: PhoneGatewayRequestCtx,
  method: string,
  routeClass: string,
  requestId: string,
  update: (value: DispatchUpdate) => void,
): { readonly idHmac: Buffer; readonly cookieHeader: string } | undefined {
  const document = routeClass === "shell" || routeClass === "security";
  if (method !== "GET" || !document || !acceptsHtml(ctx.request.rawHeaders)) {
    ctx.response.setHeader("Set-Cookie", ctx.sessions.expireCookie());
    writePhoneGatewayError(ctx.response, { code: PHONE_ERROR_CODES.PHONE_SESSION_REQUIRED, requestId });
    update({ code: PHONE_ERROR_CODES.PHONE_SESSION_REQUIRED, status: 401 });
    return undefined;
  }
  const issued = ctx.sessions.issue(ctx.config.ownerDigest);
  if (issued.kind === "capacity") {
    writePhoneGatewayError(ctx.response, { code: PHONE_ERROR_CODES.PHONE_CAPACITY_EXCEEDED, requestId });
    update({ code: PHONE_ERROR_CODES.PHONE_CAPACITY_EXCEEDED, status: 429 });
    return undefined;
  }
  ctx.response.setHeader("Set-Cookie", issued.setCookie);
  return { idHmac: issued.idHmac, cookieHeader: `${PHONE_COOKIE_NAME}=${issued.cookieId}` };
}

function acceptsHtml(rawHeaders: readonly string[]): boolean {
  const accept = headerValues(rawHeaders, "accept");
  if (accept.length !== 1 || accept[0] === undefined) return false;
  return accept[0].split(",").some(part => part.split(";")[0]?.trim().toLowerCase() === "text/html");
}
