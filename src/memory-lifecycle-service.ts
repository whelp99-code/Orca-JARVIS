import type { KeyObject } from "node:crypto";
import type { ClaimedControlCommand, ControlCommandRequestInput } from "./control-plane.js";
import { JarvisError } from "./db.js";
import type { AuthorityDatabaseRuntime } from "./authority-database-runtime.js";
import { MemoryAuthorityCompactor } from "./memory-authority-compactor.js";
import { reconcileCorrectionControls } from "./memory-correction-control.js";
import { MemoryCorrectionSaga } from "./memory-correction-saga.js";
import type { PrepareMemoryCorrectionInput } from "./memory-correction-types.js";
import { MemoryDeletionSaga } from "./memory-deletion-saga.js";
import type { PrepareMemoryDeletionInput } from "./memory-deletion-types.js";
import { MemoryExportSaga } from "./memory-export-saga.js";
import { MemoryExportStore } from "./memory-export-store.js";
import type { PrepareMemoryExportInput } from "./memory-export-types.js";
import type { MemoryLifecycleObservationSource } from "./memory-lifecycle-observation-manifest.js";
import { ProductionMemoryLifecycleObserver } from "./memory-lifecycle-observer.js";
import {
  MemoryLifecycleBarriers,
  NoopMemoryLifecycleBarrierSink,
} from "./memory-lifecycle-barriers.js";
import {
  MemoryManagedSurfaceScanner,
  type MemoryRuntimeLayout,
} from "./memory-managed-surface-scanner.js";
import type {
  MemoryLifecycleCycle,
  MemoryLifecycleExecution,
  MemoryLifecycleService,
} from "./memory-lifecycle-service-types.js";
import type { MemorySagaRuntime } from "./memory-saga-runtime.js";
import { createSecondBrainWriteRequestAdapter } from "./second-brain-write-adapter.js";
import { SecondBrainStatusObservationSource } from "./second-brain-lifecycle-observations.js";
import { SecondBrainEffectService } from "./second-brain-effect-service.js";
import { composedMemoryEffectSigningIdentity,
  type MemoryEffectSigningConfig } from "./second-brain-effect-service-production.js";
import { createSecondBrainTransport } from "./second-brain-transport.js";

export type ProductionMemoryLifecycleConfig = {
  readonly provider_instance_id: string;
  readonly launcher_path: string;
  readonly provider_config_path: string;
  readonly contract_path: string;
  /**
   * An explicitly injected fixture signer. Absent in every production composition, which signs with
   * the deployment's provisioned memory-effect identity instead.
   */
  readonly signing_key_id?: string;
  readonly private_key?: KeyObject;
  readonly signing?: MemoryEffectSigningConfig;
  readonly subject_key: Buffer;
  readonly layout: MemoryRuntimeLayout;
  readonly observation_source?: MemoryLifecycleObservationSource;
  readonly clock: () => Date;
};

export class ProductionMemoryLifecycleService implements MemoryLifecycleService {
  private readonly correction: MemoryCorrectionSaga;
  private readonly deletion: MemoryDeletionSaga;
  private readonly exportSaga: MemoryExportSaga;
  private readonly exports: MemoryExportStore;

  constructor(
    private readonly runtime: MemorySagaRuntime,
    private readonly closeRuntime: () => Promise<void>,
  ) {
    this.correction = new MemoryCorrectionSaga(runtime);
    this.deletion = new MemoryDeletionSaga(runtime);
    this.exportSaga = new MemoryExportSaga(runtime);
    this.exports = new MemoryExportStore(runtime.authority);
  }

  prepareCorrection(input: PrepareMemoryCorrectionInput): Promise<ControlCommandRequestInput> {
    return this.correction.prepare(input);
  }

  prepareDeletion(input: PrepareMemoryDeletionInput): Promise<ControlCommandRequestInput> {
    return this.deletion.prepare(input);
  }

  prepareExport(input: PrepareMemoryExportInput): Promise<ControlCommandRequestInput> {
    return this.exportSaga.prepare(input);
  }

  async execute(command: ClaimedControlCommand): Promise<MemoryLifecycleExecution> {
    switch (command.action) {
      case "memory.outbox.dispatch": {
        if (command.args.schema_version !== 3) throw new JarvisError("MEMORY_LIFECYCLE_ACTION_INVALID");
        const dispatched = await this.correction.dispatch(command);
        const record = await this.correction.reconcile(dispatched.correction_id);
        return { kind: "correction", id: record.correction_id,
          state: record.state, request_digest: record.request_digest };
      }
      case "memory.delete": {
        const dispatched = await this.deletion.dispatch(command);
        const record = await this.deletion.reconcile(dispatched.deletion_id);
        return { kind: "deletion", id: record.deletion_id, state: record.state };
      }
      case "memory.export": {
        const dispatched = await this.exportSaga.dispatch(command);
        const record = await this.exportSaga.reconcile(dispatched.export_id);
        return { kind: "export", id: record.export_id, state: record.state };
      }
      default:
        throw new JarvisError("MEMORY_LIFECYCLE_ACTION_INVALID");
    }
  }

  async reconcilePending(limit: number): Promise<MemoryLifecycleCycle> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 256) {
      throw new JarvisError("MEMORY_LIFECYCLE_LIMIT_INVALID");
    }
    const controlRecovery = reconcileCorrectionControls(this.runtime.authority, this.runtime.clock(), limit);
    let corrections = 0; let deletions = 0; let exports = 0;
    const correctionIds = this.runtime.authority.db.prepare(
      `SELECT correction_id FROM memory_correction_requests
       WHERE state IN ('reconciling','provider_proved') ORDER BY updated_at LIMIT ?`,
    ).all(limit) as Array<{ readonly correction_id: string }>;
    for (const row of correctionIds) {
      await this.correction.reconcile(row.correction_id); corrections += 1;
    }
    const remainingAfterCorrections = Math.max(0, limit - corrections);
    const deletionIds = this.runtime.authority.db.prepare(
      `SELECT deletion_id FROM memory_deletion_effect_requests
       WHERE state IN ('reconciling','provider_proved') ORDER BY updated_at LIMIT ?`,
    ).all(remainingAfterCorrections) as Array<{ readonly deletion_id: string }>;
    for (const row of deletionIds) {
      await this.deletion.reconcile(row.deletion_id); deletions += 1;
    }
    const remaining = Math.max(0, limit - corrections - deletions);
    const exportIds = this.runtime.authority.db.prepare(
      `SELECT export_id FROM memory_export_requests
       WHERE state IN ('writing','provider_proved') ORDER BY updated_at LIMIT ?`,
    ).all(remaining) as Array<{ readonly export_id: string }>;
    for (const row of exportIds) {
      await this.exportSaga.reconcile(row.export_id); exports += 1;
    }
    const expired = this.exports.expireAvailable(this.runtime.clock());
    return { corrections, deletions, exports, expired_exports: expired, ...controlRecovery };
  }

  expireExports(now: Date): Promise<MemoryLifecycleCycle> {
    const expired = this.exports.expireAvailable(now);
    return Promise.resolve({ corrections: 0, deletions: 0, exports: 0,
      expired_exports: expired });
  }

  close(): Promise<void> {
    return this.closeRuntime();
  }
}

export function createProductionMemoryLifecycleService(
  databaseRuntime: AuthorityDatabaseRuntime,
  config: ProductionMemoryLifecycleConfig,
): MemoryLifecycleService {
  if (config.subject_key.byteLength < 32 || config.provider_instance_id.length === 0) {
    throw new JarvisError("MEMORY_LIFECYCLE_CONFIG_INVALID");
  }
  // Resolved before a provider process exists: the correction, deletion and export sagas all sign
  // with this identity, and a deployment that provisioned none must be refused rather than sign
  // cancellations and tombstone fences with a key the installed provider cannot verify.
  const identity = composedMemoryEffectSigningIdentity(config, "MEMORY_LIFECYCLE_CONFIG_INVALID");
  const authority = databaseRuntime.authorityDb();
  const transport = createSecondBrainTransport({ launcherPath: config.launcher_path,
    configPath: config.provider_config_path, contractPath: config.contract_path });
  const writer = createSecondBrainWriteRequestAdapter(transport, authority, config.clock);
  const provider = new SecondBrainEffectService({ authority, transport, writer,
    clock: config.clock, provider_instance_id: config.provider_instance_id, ...identity });
  const observer = new ProductionMemoryLifecycleObserver({ authority, provider,
    observations: config.observation_source ?? new SecondBrainStatusObservationSource(provider),
    clock: config.clock });
  const scanner = new MemoryManagedSurfaceScanner({ authority, layout: config.layout });
  const compactor = new MemoryAuthorityCompactor({ runtime: databaseRuntime,
    scanner, layout: config.layout, clock: config.clock });
  const barriers = new MemoryLifecycleBarriers(authority,
    new NoopMemoryLifecycleBarrierSink());
  const runtime: MemorySagaRuntime = { authority, spool_root: config.layout.spool_root,
    writer, provider, signing_key_id: identity.signing_key_id,
    private_key: identity.private_key, subject_key: Buffer.from(config.subject_key),
    clock: config.clock, observer, compactor, barriers };
  return new ProductionMemoryLifecycleService(runtime, async () => {
    await transport.close();
    await databaseRuntime.close();
  });
}
