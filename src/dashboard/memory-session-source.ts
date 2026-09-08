import { createHash } from "node:crypto";
import type { AuthenticatedMemorySession } from "../memory-access-policy.js";
import type { PhoneGatewaySessionStore } from "./phone-session.js";

/** Request-scoped bridge. Agent identity and current owner digest must come from
 * trusted gateway configuration, never a user-supplied project/session claim.
 * Does not touch/extend the session, or grant project access. */
export function createPhoneMemorySessionSource(input: {
  readonly sessions: PhoneGatewaySessionStore;
  readonly cookieHeader: () => string | undefined;
  readonly currentOwnerDigest: () => Buffer;
  readonly agentId: string;
  readonly now: () => number;
}): () => AuthenticatedMemorySession | undefined {
  if (!/^agent:[A-Za-z0-9][A-Za-z0-9._:-]{0,121}$/.test(input.agentId)) throw new Error("MEMORY_SESSION_SOURCE_INVALID");
  const agent = input.agentId;
  return () => {
    const auth = input.sessions.authenticate(input.cookieHeader(), input.currentOwnerDigest());
    if (auth.kind !== "ok" || !Number.isFinite(auth.expiresAt) || !(input.now() < auth.expiresAt)) return undefined;
    const id = createHash("sha256").update("orca-jarvis/phone-memory-session/v1\0").update(auth.idHmac).digest("hex");
    return { principal_id: "principal:owner", agent_id: agent, session_id: `session:phone:${id}`,
      expires_at: new Date(auth.expiresAt).toISOString() };
  };
}
