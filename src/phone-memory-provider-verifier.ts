import { JarvisError, type AuthorityDb } from "./db.js";
import type { AuthenticatedMemorySession } from "./memory-access-policy.js";
import { createProductionScopedProviderVerifier, type ScopedProviderProductionOptions } from "./memory-scoped-provider-production.js";
import { parseMemoryScopedWriteRequestJson } from "./memory-scoped-write-codec.js";

export type PhoneMemoryProviderVerifierOptions = Omit<ScopedProviderProductionOptions, "authenticated_session" | "clock"> & {
  readonly authority: AuthorityDb;
  readonly agent_id: string;
};

/** Gateway owns the live session source and authority DB lifetime. Verification
 * reads the original dispatch; it neither dispatches nor accepts a memory write. */
export function createPhoneMemoryProviderVerifier(options: PhoneMemoryProviderVerifierOptions, clock: () => Date) {
  if (!/^agent:[A-Za-z0-9][A-Za-z0-9._:-]{0,121}$/.test(options.agent_id)) throw new JarvisError("MEMORY_SCOPED_CONFIG_INVALID");
  return (body: Buffer, session: () => AuthenticatedMemorySession | undefined) => {
    try {
      const raw = new TextDecoder("utf-8", { fatal: true }).decode(body);
      const request = parseMemoryScopedWriteRequestJson(raw, options.provider_instance_id, clock());
      const verify = createProductionScopedProviderVerifier(options.authority, {
        ...options, authenticated_session: session, clock,
      });
      return verify(request);
    } catch (error) {
      if (error instanceof JarvisError) {
        if (error.code === "SCOPED_WRITE_REQUEST_INVALID") throw new JarvisError("MEMORY_REFERENCE_INPUT_INVALID");
        throw new JarvisError("MEMORY_ACCESS_SCOPE_UNAVAILABLE");
      }
      throw error;
    }
  };
}
