import { serializeCookie } from "./dashboard/phone-session.js";
import type { PhoneGatewayRequestCtx, DispatchUpdate } from "./phone-gateway-request-ctx.js";
import { PHONE_ERROR_CODES } from "./phone-gateway-protocol.js";
import { writePhoneGatewayError } from "./phone-gateway-http.js";

export function phoneRequestAuthentication(ctx: PhoneGatewayRequestCtx, cookieHeader: string | undefined,
  idHmac: Buffer, requestId: string, update: (value: DispatchUpdate) => void) {
  const isAuthenticated = (): boolean => {
    const current = ctx.sessions.authenticate(cookieHeader, ctx.config.ownerDigest);
    return current.kind === "ok" && current.idHmac.equals(idHmac);
  };
  const rejectAuthentication = (): false => {
    ctx.response.setHeader("Set-Cookie", ctx.sessions.expireCookie());
    writePhoneGatewayError(ctx.response, { code: PHONE_ERROR_CODES.PHONE_SESSION_REQUIRED, requestId });
    update({ code: PHONE_ERROR_CODES.PHONE_SESSION_REQUIRED, status: 401, outcome: "rejected" });
    return false;
  };
  const stillAuthenticated = (): boolean => isAuthenticated() || rejectAuthentication();
  const refreshCookie = (): void => {
    const refreshed = ctx.sessions.touch(idHmac);
    if (refreshed !== undefined) {
      ctx.response.setHeader("Set-Cookie", serializeCookie(cookieId(cookieHeader), refreshed.maxAge));
    }
  };
  return { isAuthenticated, rejectAuthentication, stillAuthenticated, refreshCookie };
}

function cookieId(header: string | undefined): string {
  if (header === undefined) return "";
  const match = /__Host-jarvis-phone=([^;]+)/.exec(header);
  return match?.[1] ?? "";
}
