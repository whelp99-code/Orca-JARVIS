import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { ApprovedCommandExecutor } from "../approved-executor.js";
import { JarvisError, type AuthorityDb } from "../db.js";
import { createProductionMemoryOutbox, memoryCandidateSpoolRoots } from "../memory-outbox-production.js";
import type { MemoryOutboxService } from "../memory-outbox.js";
import { createSecondBrainReadAdapter } from "../second-brain-adapter.js";
import type { SecondBrainAdapterOptions } from "../second-brain-adapter-types.js";
import {
  createSecondBrainTransport,
  type SecondBrainTransport,
  type SecondBrainTransportOptions,
} from "../second-brain-transport.js";
import type { DashboardExecutorFactory } from "./authority-service.js";
import type { DashboardMemoryDependencies } from "./main.js";
import { createProductionMemoryReadFence } from "../memory-read-fence-production.js";

const BUDGETS = { max_hits: 8, max_excerpt_bytes: 1_024, max_total_bytes: 65_536,
  max_page_bytes: 1_048_576 } as const;

export type BoundDashboardMemory = {
  readonly memoryAdapter: ReturnType<typeof createSecondBrainReadAdapter> | undefined;
  readonly memoryProjectionKey: Buffer;
  readonly memoryEffectSpoolRoot: string;
  readonly memoryCandidateReviewSpoolRoot: string;
  readonly memoryCandidateDispatchSpoolRoot: string;
  readonly executorFactory: DashboardExecutorFactory;
  readonly ownedProviderTransport: SecondBrainTransport | undefined;
  readonly outboxFor: (authority: AuthorityDb) => MemoryOutboxService | undefined;
};

function privateDir(path: string): string {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
  return path;
}

function projectionKey(path: string): Buffer {
  try {
    const bytes = readFileSync(path);
    if (bytes.byteLength !== 32) throw new JarvisError("VALIDATION_ERROR");
    return bytes;
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
  }
  const key = randomBytes(32);
  try {
    writeFileSync(path, key, { mode: 0o600, flag: "wx" });
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
    // Another startup won creation. Never overwrite its persistent identity.
    const existing = readFileSync(path);
    if (existing.byteLength !== 32) throw new JarvisError("VALIDATION_ERROR");
    return existing;
  }
  return key;
}

function adapterOptions(): Omit<SecondBrainAdapterOptions, "transport"> {
  return { budgets: BUDGETS, clock: () => new Date(), max_age_ms: 7 * 86_400_000,
    expiry_ms: 30 * 86_400_000, contract_profile: "schema4" };
}

export function bindDashboardMemoryDependencies(
  authority: AuthorityDb,
  dependencies: DashboardMemoryDependencies,
): BoundDashboardMemory {
  const dbPath = authority.filename; const root = dirname(dbPath);
  const effect = dependencies.memoryEffectSpoolRoot ?? privateDir(join(root, "memory-effect-spool"));
  const roots = memoryCandidateSpoolRoots(dbPath, {
    candidate_review_spool_root: dependencies.memoryCandidateReviewSpoolRoot,
    candidate_dispatch_spool_root: dependencies.memoryCandidateDispatchSpoolRoot });
  const review = privateDir(roots.candidate_review_spool_root);
  const dispatch = privateDir(roots.candidate_dispatch_spool_root);
  const key = dependencies.memoryProjectionKey ?? projectionKey(join(root, "memory-projection.key"));
  const originalOptions = dependencies.memoryAdapterOptions ?? adapterOptions();
  const readFence = originalOptions.read_fence ?? (dependencies.memoryAdapter === undefined
    ? createProductionMemoryReadFence(authority, dependencies.memoryReadFenceConfig) : undefined);
  const options = { ...originalOptions, read_fence: readFence };
  const transportOptions: SecondBrainTransportOptions = dependencies.providerTransportOptions ?? {};
  const ownedProviderTransport = dependencies.providerTransport === undefined && dependencies.memoryAdapter === undefined
    ? createSecondBrainTransport(transportOptions) : undefined;
  const transport = dependencies.providerTransport ?? ownedProviderTransport;
  const outboxes = new WeakMap<AuthorityDb, MemoryOutboxService>();
  const outboxFor = (authority: AuthorityDb): MemoryOutboxService | undefined => {
    if (transport === undefined || (dependencies.memoryAdapter?.contract_profile
      ?? options.contract_profile ?? "schema3-read-only") !== "schema4") return undefined;
    let service = outboxes.get(authority);
    if (service === undefined) {
      service = createProductionMemoryOutbox(authority, { transport, clock: options.clock, read_fence: originalOptions.read_fence,
        read_fence_config: dependencies.memoryReadFenceConfig, ...roots }).service;
      outboxes.set(authority, service);
    }
    return service;
  };
  const executorFactory = dependencies.executorFactory ?? ((input): ApprovedCommandExecutor =>
    new ApprovedCommandExecutor(input.db, resolve(".jarvis-backups"), resolve("state"), {},
      options.clock, outboxFor(input.db), undefined, input.memoryLifecycle));
  return {
    memoryAdapter: dependencies.memoryAdapter ?? (transport === undefined ? undefined
      : createSecondBrainReadAdapter({ ...options, transport })),
    memoryProjectionKey: key, memoryEffectSpoolRoot: effect, memoryCandidateReviewSpoolRoot: review,
    memoryCandidateDispatchSpoolRoot: dispatch, executorFactory, ownedProviderTransport, outboxFor,
  };
}
