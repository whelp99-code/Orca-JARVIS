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
  return { isAuthenticated, rejectAuthentication, stillAuthenticated };
}
