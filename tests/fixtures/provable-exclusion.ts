import { AuthorityDatabaseRuntime } from "../../src/authority-database-runtime.js";

/**
 * SIMULATES the answer a host with no hidden processes would give. It is not a proof of isolation
 * and it does not make the environment safe: the operating system is unchanged, and a same-uid
 * process that never went through admission can still open the database - before this answer or
 * after it, since any observation is an instant and the rename is a later syscall. What it buys is
 * that a test about something else does not have to run on this host's incomplete answer.
 *
 * The contract that actually holds in production is the refusal: on an answer with a hole, the
 * swap does not replace anything. The case that covers entry AFTER the last question is a separate
 * one, and it asserts preservation rather than exclusion, because exclusion is not what is
 * available there.
 *
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
