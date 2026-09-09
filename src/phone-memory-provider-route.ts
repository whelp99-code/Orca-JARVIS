import type { DispatchUpdate, PhoneGatewayRequestCtx } from "./phone-gateway-request-ctx.js";
import { createPhoneMemorySessionSource } from "./dashboard/memory-session-source.js";
import { phoneMemoryContextError } from "./phone-memory-context-error.js";
import { ERROR_STATUS, PHONE_ERROR_CODES } from "./phone-gateway-protocol.js";
import { retryAfter, writeJson, writePhoneGatewayError } from "./phone-gateway-http.js";

/** Runs only after owner, session, CSRF and body validation in the gateway. */
export async function servePhoneMemoryProviderVerification(ctx: PhoneGatewayRequestCtx,
  cookieHeader: string | undefined, body: Buffer | undefined, requestId: string,
  update: (value: DispatchUpdate) => void, stillAuthenticated: () => boolean): Promise<void> {
  if (ctx.memoryProviderVerifier === undefined || ctx.memoryProviderAgentId === undefined || body === undefined) {
    writePhoneGatewayError(ctx.response, { code: PHONE_ERROR_CODES.PHONE_NOT_READY, requestId });
    update({ code: PHONE_ERROR_CODES.PHONE_NOT_READY, status: 503 }); return;
  }
  const session = createPhoneMemorySessionSource({ sessions: ctx.sessions, cookieHeader: () => cookieHeader,
    currentOwnerDigest: () => ctx.config.ownerDigest, agentId: ctx.memoryProviderAgentId, now: ctx.now });
  let result;
  try { result = await ctx.memoryProviderVerifier(body, session); }
  catch (error) {
    if (!stillAuthenticated()) return;
    const code = phoneMemoryContextError(error);
    if (code === undefined) throw error;
    writePhoneGatewayError(ctx.response, { code, requestId });
    update({ code, status: ERROR_STATUS[code], outcome: "rejected" }); return;
  }
  if (!stillAuthenticated()) return;
  // Canonical scalar decision fields support the bounded provider channel.
  // Verification never renews a login or creates a reusable write grant.
  const canonicalResult = Object.fromEntries(Object.keys(result).sort().map(key => [key, Reflect.get(result, key)]));
  writeJson(ctx.response, 200, requestId, canonicalResult, true);
  update({ outcome: "allowed", code: "ok", status: 200 }); return;
}

/** Reconciliation uses the same live session checks as provider verification. */
export async function servePhoneMemoryReconciliation(ctx: PhoneGatewayRequestCtx,
  cookieHeader: string | undefined, body: Buffer | undefined, requestId: string,
  update: (value: DispatchUpdate) => void, stillAuthenticated: () => boolean): Promise<void> {
    if (ctx.memoryReconcile === undefined || ctx.memoryReconcileAgentId === undefined || body === undefined) {
      writePhoneGatewayError(ctx.response, { code: PHONE_ERROR_CODES.PHONE_NOT_READY, requestId });
      update({ code: PHONE_ERROR_CODES.PHONE_NOT_READY, status: 503 }); return;
    }
    const session = createPhoneMemorySessionSource({ sessions: ctx.sessions, cookieHeader: () => cookieHeader,
      currentOwnerDigest: () => ctx.config.ownerDigest, agentId: ctx.memoryReconcileAgentId, now: ctx.now });
    let result;
    try { result = await ctx.memoryReconcile(body, session); }
    catch (error) {
      if (!stillAuthenticated()) return;
      const code = phoneMemoryContextError(error);
      if (code === undefined) throw error;
      if (code === PHONE_ERROR_CODES.PHONE_CAPACITY_EXCEEDED) retryAfter(ctx.response, 1);
      writePhoneGatewayError(ctx.response, { code, requestId });
      update({ code, status: ERROR_STATUS[code], outcome: "rejected" }); return;
    }
    if (!stillAuthenticated()) return;
    writeJson(ctx.response, 200, requestId, result, true);
    update({ outcome: "allowed", code: "ok", status: 200 }); return;
}
