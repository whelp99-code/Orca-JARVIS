import { dirname, join, resolve } from "node:path";
import type { AuthorityDb } from "./db.js";
import { MemoryOutboxService } from "./memory-outbox.js";
import type { MemoryOutboxSpoolRoots } from "./memory-outbox-values.js";
import { createSecondBrainReadAdapter } from "./second-brain-adapter.js";
import { createSecondBrainWriteRequestAdapter } from "./second-brain-write-adapter.js";
import { createSecondBrainTransport, type SecondBrainTransport, type SecondBrainTransportOptions } from "./second-brain-transport.js";
import { registerMemoryCandidateSpoolRoots } from "./memory-surface-authority.js";
import type { SecondBrainAdapterOptions } from "./second-brain-adapter-types.js";

export type MemoryOutboxProductionOptions = MemoryOutboxSpoolRoots & {
  readonly transport?: SecondBrainTransport;
  readonly transport_options?: SecondBrainTransportOptions;
  readonly clock?: () => Date;
  readonly read_fence?: SecondBrainAdapterOptions["read_fence"];
};

export function memoryCandidateSpoolRoots(filename: string, options: MemoryOutboxSpoolRoots = {}) {
  const root = dirname(resolve(filename));
  return {
    candidate_review_spool_root: options.candidate_review_spool_root
      ?? process.env.JARVIS_MEMORY_REVIEW_SPOOL_ROOT ?? join(root, "memory-review-spool"),
    candidate_dispatch_spool_root: options.candidate_dispatch_spool_root
      ?? process.env.JARVIS_MEMORY_DISPATCH_SPOOL_ROOT ?? join(root, "memory-dispatch-spool"),
  };
}

export function bindMemoryCandidateSpools(authority: AuthorityDb, options: MemoryOutboxSpoolRoots = {}) {
  const roots = memoryCandidateSpoolRoots(authority.filename, options);
  registerMemoryCandidateSpoolRoots(authority, { review_root: roots.candidate_review_spool_root,
    dispatch_root: roots.candidate_dispatch_spool_root });
  return roots;
}

/** Completion reads use an explicit bounded record-set profile. Ordinary search
 * budgets and transport ownership remain with their original callers. */
export function createProductionMemoryOutbox(authority: AuthorityDb, options: MemoryOutboxProductionOptions = {}) {
  const roots = bindMemoryCandidateSpools(authority, options);
  const clock = options.clock ?? (() => new Date());
  const transport = options.transport ?? createSecondBrainTransport(options.transport_options);
  const reader = createSecondBrainReadAdapter({ transport, clock, contract_profile: "schema4", read_fence: options.read_fence,
    budget_profile: "record-set-v1", budgets: { max_hits: 8, max_excerpt_bytes: 4_096,
      max_total_bytes: 262_144, max_page_bytes: 262_144 },
    max_age_ms: 7 * 86_400_000, expiry_ms: 30 * 86_400_000 });
  const service = new MemoryOutboxService({ authority, clock, reader,
    writer: createSecondBrainWriteRequestAdapter(transport, authority, clock), ...roots });
  return { service, reader, close: async (): Promise<void> => {
    if (options.transport === undefined) await transport.close();
  } };
}
