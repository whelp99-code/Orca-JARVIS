import { JarvisError, type AuthorityDb } from "./db.js";
import { createFileMemoryWriteScopeResolver, type AuthenticatedMemorySession } from "./memory-access-policy.js";
import { verifyMemoryScopedProviderWrite } from "./memory-scoped-provider-authority.js";

export type ScopedProviderProductionOptions = {
  readonly policy_path: string;
  readonly provider_instance_id: string;
  readonly spool_root: string;
  readonly roots: { readonly dispatch?: string; readonly review?: string };
  readonly authenticated_session: () => AuthenticatedMemorySession | undefined;
  readonly clock?: () => Date;
};

/** Server-owned authenticated session only. Incoming request labels must never
 * populate this callback. No keys, grants, sessions, DB rows or transport are
 * created here; each use re-reads current policy and the original spent attempt. */
export function createProductionScopedProviderVerifier(authority: AuthorityDb, options: ScopedProviderProductionOptions) {
  if (typeof options.authenticated_session !== "function") throw new JarvisError("SCOPED_PROVIDER_CONFIG_INVALID");
  const resolveWriteScope = createFileMemoryWriteScopeResolver(options.policy_path,
    options.provider_instance_id, options.authenticated_session);
  const input = { authority, resolveWriteScope, providerInstanceId: options.provider_instance_id,
    spoolRoot: options.spool_root, roots: Object.freeze({ ...options.roots }), clock: options.clock ?? (() => new Date()) };
  return (request: unknown) => verifyMemoryScopedProviderWrite(input, request);
}
