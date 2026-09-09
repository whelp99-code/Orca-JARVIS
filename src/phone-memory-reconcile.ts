import { isAbsolute } from "node:path";
import { JarvisError } from "./db.js";
import { execute } from "./cli-runtime.mjs";
import type { AuthenticatedMemorySession } from "./memory-access-policy.js";
import type { ScopedReconcileProductionOptions } from "./memory-scoped-reconcile-production.js";
import { validateMemoryBody } from "./phone-gateway-body.js";

export type PhoneMemoryReconcileOptions = {
  readonly database_path: string;
  readonly agent_id: string;
  readonly memory: Omit<ScopedReconcileProductionOptions, "authenticated_session" | "clock">;
};

/** Explicit recovery of a spent request under a live gateway session. No writes
 * are dispatched and no session is extended; errors may follow a durable commit. */
export function createPhoneMemoryReconcile(options: PhoneMemoryReconcileOptions, clock: () => Date) {
  if (!isAbsolute(options.database_path) || !/^agent:[A-Za-z0-9][A-Za-z0-9._:-]{0,121}$/.test(options.agent_id))
    throw new JarvisError("MEMORY_SCOPED_CONFIG_INVALID");
  let active = 0;
  return async (body: Buffer, session: () => AuthenticatedMemorySession | undefined) => {
    if (!validateMemoryBody("/api/v1/memory/reconcile", body)) throw new JarvisError("MEMORY_REFERENCE_INPUT_INVALID");
    if (active >= 8) throw new JarvisError("MEMORY_CONTEXT_BUSY");
    active++;
    try {
      const input = JSON.parse(body.toString("utf8")) as { outbox_id: string };
      const result = await execute(["memory", "reconcile-scoped", input.outbox_id, "--once", "--db", options.database_path], {
        clock, scopedMemoryReconcileOptions: { ...options.memory, authenticated_session: session },
      });
      return { schema_version: 1, ...result };
    } catch (error) {
      if (error instanceof JarvisError) {
        if (error.code === "MEMORY_ACCESS_SCOPE_UNAVAILABLE" || error.code === "SCOPED_RECONCILIATION_INVALID")
          throw new JarvisError("MEMORY_ACCESS_SCOPE_UNAVAILABLE");
        throw new JarvisError("MEMORY_REFERENCE_PROVIDER_UNAVAILABLE");
      }
      throw error;
    } finally { active--; }
  };
}
