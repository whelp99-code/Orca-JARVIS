import type { KeyObject } from "node:crypto";
import type { AuthorityDb } from "./db.js";
import { JarvisError } from "./db.js";
import { MemoryTargetResolver } from "./memory-target-resolver.js";
import { MemoryWithdrawalEffect } from "./memory-withdrawal-effect.js";
import type { MemoryReferenceProductionOptions } from "./memory-reference-production.js";
import { createProductionMemoryReadFence } from "./memory-read-fence-production.js";
import { createSecondBrainReadAdapter } from "./second-brain-adapter.js";
import { createSecondBrainTransport } from "./second-brain-transport.js";
import { SecondBrainEffectService } from "./second-brain-effect-service.js";
import { composedMemoryEffectSigningIdentity,
  type MemoryEffectSigningConfig } from "./second-brain-effect-service-production.js";

export type MemoryWithdrawalProductionOptions = MemoryReferenceProductionOptions & {
  readonly provider_instance_id: string;
  /**
   * An explicitly injected fixture signer. Absent in every production composition, which signs with
   * the deployment's provisioned memory-effect identity instead.
   */
  readonly signing_key_id?: string;
  readonly private_key?: KeyObject;
  readonly signing?: MemoryEffectSigningConfig;
  readonly approval_window_ms?: number;
};

/**
 * The withdrawal planner, wired to the real provider transport.
 *
 * The write side is deliberately absent. Preparing a withdrawal reads the provider and stops at the
 * command the owner has to approve; the effect itself travels the existing deletion saga and outbox,
 * which own the writer. A planner that could write would be a second route to the same effect.
 */
export function createProductionMemoryWithdrawal(
  authority: AuthorityDb, options: MemoryWithdrawalProductionOptions,
) {
  if (options.provider_instance_id.length === 0) {
    throw new JarvisError("MEMORY_WITHDRAWAL_CONFIG_INVALID");
  }
  const identity = composedMemoryEffectSigningIdentity(options, "MEMORY_WITHDRAWAL_CONFIG_INVALID");
  const clock = options.clock ?? (() => new Date());
  const transport = options.transport ?? createSecondBrainTransport(options.transport_options);
  const effect = new SecondBrainEffectService({ authority, transport, clock,
    writer: { write: () => Promise.reject(new JarvisError("MEMORY_WITHDRAWAL_IS_READ_ONLY")) },
    provider_instance_id: options.provider_instance_id, ...identity });
  const readFence = options.read_fence
    ?? createProductionMemoryReadFence(authority, options.read_fence_config)
    ?? effect.readFenceFactory();
  const reader = createSecondBrainReadAdapter({ transport, clock, contract_profile: "schema4",
    read_fence: readFence, budget_profile: "record-set-v1",
    budgets: { max_hits: 8, max_excerpt_bytes: 4_096,
      max_total_bytes: 262_144, max_page_bytes: 262_144 },
    max_age_ms: 7 * 86_400_000, expiry_ms: 30 * 86_400_000 });
  const withdrawal = new MemoryWithdrawalEffect({ authority, reader, clock,
    resolver: new MemoryTargetResolver(effect),
    ...(options.approval_window_ms === undefined
      ? {} : { approval_window_ms: options.approval_window_ms }) });
  return { withdrawal, reader, close: async (): Promise<void> => {
    if (options.transport === undefined) await transport.close();
  } };
}
