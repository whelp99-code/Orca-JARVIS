import type { AuthenticatedMemorySession } from "./memory-access-policy.js";
import type { ScopedMemoryProductionOptions } from "./memory-scoped-production.js";
import { execute } from "./cli-runtime.mjs";
import { JarvisError } from "./db.js";
import { isAbsolute } from "node:path";

export type PhoneMemoryContextOptions = {
  readonly database_path: string;
  readonly agent_id: string;
  readonly memory: Omit<ScopedMemoryProductionOptions, "authenticated_session" | "clock">;
};

/** One server-owned bounded context service. No implicit policy/session grants. */
export function createPhoneMemoryContext(options: PhoneMemoryContextOptions, clock: () => Date) {
  if (!isAbsolute(options.database_path) || !/^agent:[A-Za-z0-9][A-Za-z0-9._:-]{0,121}$/.test(options.agent_id)) {
    throw new JarvisError("MEMORY_SCOPED_CONFIG_INVALID");
  }
  let active = 0;
  return async (body: Buffer, session: () => AuthenticatedMemorySession | undefined) => {
    if (active >= 8) throw new JarvisError("MEMORY_CONTEXT_BUSY");
    active++;
    try {
      const input = JSON.parse(body.toString("utf8")) as { query: string; limit: number; max_bytes: number };
      const result = await execute(["memory", "context", input.query, "--db", options.database_path,
        "--limit", String(input.limit), "--max_bytes", String(input.max_bytes - 16)], {
        clock, scopedMemoryReferenceOptions: { ...options.memory, authenticated_session: session },
      });
      const response = { schema_version: 1, ...result };
      if (Buffer.byteLength(JSON.stringify(response)) > input.max_bytes) throw new JarvisError("MEMORY_REFERENCE_BUDGET_IMPOSSIBLE");
      return response;
    } finally { active--; }
  };
}
