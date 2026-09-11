import { AuthorityDatabaseRuntime } from "../../src/authority-database-runtime.js";

/**
 * Declares this runtime's environment one where exclusion can be proved, by accounting for the
 * processes the scan could not read. A destructive swap refuses while any of them stands, which
 * is the product default; a test that needs the swap to proceed has to establish the condition
 * rather than have it assumed, and this is where that establishment is written down.
 *
 * Only the hole is accounted for: holders the scan did see are left exactly as observed, so every
 * refusal that depends on a real holder still fires.
 */
export function withProvableExclusion(runtime: AuthorityDatabaseRuntime): AuthorityDatabaseRuntime {
  const observe = runtime.observeExclusion.bind(runtime);
  runtime.observeExclusion = ((device: bigint, inode: bigint) =>
    ({ ...observe(device, inode), unprovable: [] })) as typeof runtime.observeExclusion;
  return runtime;
}
