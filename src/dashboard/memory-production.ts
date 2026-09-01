import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { ApprovedCommandExecutor } from "../approved-executor.js";
import { JarvisError } from "../db.js";
import { createSecondBrainReadAdapter } from "../second-brain-adapter.js";
import type { SecondBrainAdapterOptions } from "../second-brain-adapter-types.js";
import {
  createSecondBrainTransport,
  type SecondBrainTransport,
  type SecondBrainTransportOptions,
} from "../second-brain-transport.js";
import type { DashboardExecutorFactory } from "./authority-service.js";
import type { DashboardMemoryDependencies } from "./main.js";

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
  writeFileSync(path, key, { mode: 0o600 });
  chmodSync(path, 0o600);
  return key;
}

function adapterOptions(): Omit<SecondBrainAdapterOptions, "transport"> {
  return { budgets: BUDGETS, clock: () => new Date(), max_age_ms: 7 * 86_400_000,
    expiry_ms: 30 * 86_400_000, contract_profile: "schema4" };
}

export function bindDashboardMemoryDependencies(
  dbPath: string,
  dependencies: DashboardMemoryDependencies,
): BoundDashboardMemory {
  const root = dirname(dbPath);
  const effect = dependencies.memoryEffectSpoolRoot ?? privateDir(join(root, "memory-effect-spool"));
  const review = dependencies.memoryCandidateReviewSpoolRoot
    ?? privateDir(join(root, "memory-review-spool"));
  const dispatch = dependencies.memoryCandidateDispatchSpoolRoot
    ?? privateDir(join(root, "memory-dispatch-spool"));
  const key = dependencies.memoryProjectionKey ?? projectionKey(join(root, "memory-projection.key"));
  const executorFactory = dependencies.executorFactory ?? ((input): ApprovedCommandExecutor =>
    new ApprovedCommandExecutor(input.db, resolve(".jarvis-backups"), resolve("state"), {},
      () => input.now, undefined, undefined, input.memoryLifecycle));
  if (dependencies.memoryAdapter !== undefined) {
    return { memoryAdapter: dependencies.memoryAdapter, memoryProjectionKey: key,
      memoryEffectSpoolRoot: effect, memoryCandidateReviewSpoolRoot: review,
      memoryCandidateDispatchSpoolRoot: dispatch, executorFactory, ownedProviderTransport: undefined };
  }
  const transportOptions: SecondBrainTransportOptions = dependencies.providerTransportOptions ?? {};
  if (dependencies.providerTransport !== undefined) {
    return {
      memoryAdapter: createSecondBrainReadAdapter({
        ...(dependencies.memoryAdapterOptions ?? adapterOptions()),
        transport: dependencies.providerTransport,
      }),
      memoryProjectionKey: key, memoryEffectSpoolRoot: effect, memoryCandidateReviewSpoolRoot: review,
      memoryCandidateDispatchSpoolRoot: dispatch, executorFactory, ownedProviderTransport: undefined,
    };
  }
  const ownedProviderTransport = createSecondBrainTransport(transportOptions);
  return {
    memoryAdapter: createSecondBrainReadAdapter({
      ...(dependencies.memoryAdapterOptions ?? adapterOptions()), transport: ownedProviderTransport,
    }),
    memoryProjectionKey: key, memoryEffectSpoolRoot: effect, memoryCandidateReviewSpoolRoot: review,
    memoryCandidateDispatchSpoolRoot: dispatch, executorFactory, ownedProviderTransport,
  };
}
