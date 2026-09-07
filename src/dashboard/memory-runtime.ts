import { randomBytes } from "node:crypto";
import type { AuthorityDb } from "../db.js";
import type { SecondBrainReadAdapter } from "../second-brain-adapter-types.js";
import { MemoryMutationService } from "./memory-mutation-service.js";
import { MemoryReadService } from "./memory-read-service.js";
import { MemoryTokenCache } from "./memory-token-cache.js";
import type { DashboardSessionStore } from "./session.js";

export type MemoryRuntime = { readonly read: MemoryReadService;
  readonly mutation: MemoryMutationService | undefined; readonly mutations_enabled: boolean };
export type MemoryRuntimeOptions = { readonly authority: AuthorityDb; readonly session: DashboardSessionStore;
  readonly clock: () => Date; readonly adapter?: SecondBrainReadAdapter; readonly projection_key?: Buffer;
  readonly effect_spool_root?: string; readonly candidate_review_spool_root?: string;
  readonly candidate_dispatch_spool_root?: string };
export function createMemoryRuntime(options: MemoryRuntimeOptions): MemoryRuntime {
  const tokens = new MemoryTokenCache(options.projection_key ?? randomBytes(32), options.clock);
  const mutation = options.adapter?.contract_profile !== "schema4" ? undefined : new MemoryMutationService({
    authority: options.authority, tokens, session: options.session, clock: options.clock,
    spool_root: options.effect_spool_root, candidate_review_spool_root: options.candidate_review_spool_root,
    candidate_dispatch_spool_root: options.candidate_dispatch_spool_root });
  return { read: new MemoryReadService({ authority: options.authority, adapter: options.adapter,
    tokens, session: options.session, clock: options.clock,
    candidate_review_spool_root: options.candidate_review_spool_root }), mutation,
    mutations_enabled: mutation !== undefined };
}
