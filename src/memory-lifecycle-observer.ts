import type { AuthorityDb } from "./db.js";
import { JarvisError } from "./db.js";
import type { MemoryCorrectionRecord } from "./memory-correction-store.js";
import type { MemoryDeletionRecord } from "./memory-deletion-store.js";
import {
  verifyMemoryDispositionProof,
  type MemoryDispositionProofV1,
  type MemoryProofExpectation,
} from "./memory-disposition-proof.js";
import type { MemoryExportRecord } from "./memory-export-store.js";
import {
  type MemoryLifecycleObservationBinding,
  type MemoryLifecycleObservationSource,
  type ParsedMemoryLifecycleObservationManifest,
} from "./memory-lifecycle-observation-manifest.js";
import type {
  CorrectionLifecycleObservation,
  DeletionLifecycleObservation,
  ExportLifecycleObservation,
  MemoryLifecycleObserver,
  NotProved,
  VerifiedGenerationObservation,
} from "./memory-lifecycle-observation-types.js";
import type { SecondBrainEffectService } from "./second-brain-effect-service.js";

export type ProductionMemoryLifecycleObserverOptions = {
  readonly authority: AuthorityDb;
  readonly provider: SecondBrainEffectService;
  readonly observations: MemoryLifecycleObservationSource;
  readonly clock: () => Date;
};

function isNotProved(value: MemoryDispositionProofV1 | NotProved): value is NotProved {
  return "kind" in value && value.kind === "not_proved";
}

export class ProductionMemoryLifecycleObserver implements MemoryLifecycleObserver {
  constructor(private readonly options: ProductionMemoryLifecycleObserverOptions) {}

  async correction(record: MemoryCorrectionRecord): Promise<CorrectionLifecycleObservation | NotProved> {
    const proof = await this.proof(this.correctionExpectation(record));
    if (isNotProved(proof)) return proof;
    const observed = await this.observation(proof);
    const generation = await this.generation(proof, true, observed.generation_manifest_digest);
    switch (observed.result.kind) {
      case "correction":
        return { kind: "correction", proof, generation, replacement: observed.result,
          provider_inventory: observed.provider_inventory,
          reingress_guards: observed.reingress_guards };
      case "deletion": case "export":
        throw new JarvisError("MEMORY_LIFECYCLE_OBSERVATION_BINDING_INVALID");
      default:
        return assertNever(observed.result);
    }
  }

  async deletion(record: MemoryDeletionRecord): Promise<DeletionLifecycleObservation | NotProved> {
    const expectation = this.deletionExpectation(record);
    if (expectation === undefined) return { kind: "not_proved", code: "MEMORY_DELETION_NOT_PREPARED" };
    const proof = await this.proof(expectation);
    if (isNotProved(proof)) return proof;
    const observed = await this.observation(proof);
    const generation = await this.generation(proof, true, observed.generation_manifest_digest);
    switch (observed.result.kind) {
      case "deletion":
        return { kind: "deletion", proof, generation, absence: observed.result,
          provider_inventory: observed.provider_inventory,
          reingress_guards: observed.reingress_guards };
      case "correction": case "export":
        throw new JarvisError("MEMORY_LIFECYCLE_OBSERVATION_BINDING_INVALID");
      default:
        return assertNever(observed.result);
    }
  }

  async export(record: MemoryExportRecord): Promise<ExportLifecycleObservation | NotProved> {
    const expectation = this.exportExpectation(record);
    if (expectation === undefined) return { kind: "not_proved", code: "MEMORY_EXPORT_NOT_PREPARED" };
    const proof = await this.proof(expectation);
    if (isNotProved(proof)) return proof;
    const observed = await this.observation(proof);
    const generation = await this.generation(proof, false, observed.generation_manifest_digest);
    switch (observed.result.kind) {
      case "export":
        return { kind: "export", proof, generation, export: observed.result,
          provider_inventory: observed.provider_inventory,
          reingress_guards: observed.reingress_guards };
      case "correction": case "deletion":
        throw new JarvisError("MEMORY_LIFECYCLE_OBSERVATION_BINDING_INVALID");
      default:
        return assertNever(observed.result);
    }
  }

  private async proof(expected: MemoryProofExpectation): Promise<MemoryDispositionProofV1 | NotProved> {
    const status = await this.options.provider.requestStatus(expected.request_id);
    switch (status.kind) {
      case "data":
        if (status.value.state !== "proved") return { kind: "not_proved",
          code: `MEMORY_PROVIDER_${String(status.value.state).toUpperCase()}` };
        return verifyMemoryDispositionProof(this.options.authority,
          status.value.proof, expected, this.options.clock());
      case "invalid": case "unavailable": case "uncertain":
        return { kind: "not_proved", code: status.code };
      default:
        return assertNever(status);
    }
  }

  private async observation(
    proof: MemoryDispositionProofV1,
  ): Promise<ParsedMemoryLifecycleObservationManifest> {
    const observed = await this.options.observations.observe(this.observationBinding(proof));
    const observedAt = Date.parse(observed.observed_at);
    if (observedAt < Date.parse(proof.completed_at) || observedAt > this.options.clock().getTime()) {
      throw new JarvisError("MEMORY_LIFECYCLE_OBSERVATION_TIME_INVALID");
    }
    return observed;
  }

  private async generation(
    proof: MemoryDispositionProofV1,
    restart: boolean,
    observedManifestDigest: string,
  ): Promise<VerifiedGenerationObservation> {
    const result = restart
      ? await this.options.provider.restartForGeneration(proof.result_generation_id)
      : await this.options.provider.generationStatus();
    switch (result.kind) {
      case "data": {
        const value = result.value;
        if (value.generation_id !== proof.result_generation_id
          || typeof value.generation_manifest_digest !== "string"
          || value.generation_manifest_digest !== observedManifestDigest
          || value.tombstone_sequence !== proof.tombstone_sequence
          || value.tombstone_set_root !== proof.tombstone_set_root) {
          throw new JarvisError("MEMORY_LIFECYCLE_GENERATION_INVALID");
        }
        return { generation_id: proof.result_generation_id,
          generation_manifest_digest: value.generation_manifest_digest,
          tombstone_sequence: proof.tombstone_sequence,
          tombstone_set_root: proof.tombstone_set_root };
      }
      case "invalid": case "unavailable": case "uncertain":
        throw new JarvisError("MEMORY_LIFECYCLE_GENERATION_INVALID");
      default:
        return assertNever(result);
    }
  }

  private observationBinding(proof: MemoryDispositionProofV1): MemoryLifecycleObservationBinding {
    return { request_id: proof.request_id, operation: proof.operation,
      provider_instance_id: proof.provider_instance_id,
      target_manifest_digest: proof.target_manifest_digest,
      result_generation_id: proof.result_generation_id,
      result_head: proof.result_head, result_tree: proof.result_tree,
      tombstone_sequence: proof.tombstone_sequence,
      tombstone_set_root: proof.tombstone_set_root,
      surface_manifest_digest: proof.surface_manifest_digest,
      artifact_manifest_digest: proof.artifact_manifest_digest,
      export_manifest_digest: proof.export_manifest_digest };
  }

  private correctionExpectation(record: MemoryCorrectionRecord): MemoryProofExpectation {
    return { provider_instance_id: record.provider_instance_id,
      request_id: record.request_id, request_digest: record.request_digest,
      envelope_digest: record.envelope_digest, idempotency_key: record.idempotency_key,
      delegation_id: record.delegation_id, delegation_digest: record.delegation_digest,
      lane_id: record.lane_id, operation: "correct", payload_digest: record.payload_digest,
      target_manifest_digest: record.target_manifest_digest, scope_digest: record.scope_digest,
      tombstone_sequence: record.tombstone_sequence,
      tombstone_set_root: record.tombstone_set_root };
  }

  private deletionExpectation(record: MemoryDeletionRecord): MemoryProofExpectation | undefined {
    if (record.provider_instance_id === null || record.request_id === null
      || record.request_digest === null || record.envelope_digest === null
      || record.provider_idempotency_key === null || record.delegation_id === null
      || record.delegation_digest === null || record.lane_id === null
      || record.tombstone_sequence === null || record.tombstone_set_root === null) return undefined;
    return { provider_instance_id: record.provider_instance_id,
      request_id: record.request_id, request_digest: record.request_digest,
      envelope_digest: record.envelope_digest, idempotency_key: record.provider_idempotency_key,
      delegation_id: record.delegation_id, delegation_digest: record.delegation_digest,
      lane_id: record.lane_id, operation: "forget", payload_digest: record.payload_digest,
      target_manifest_digest: record.target_manifest_digest, scope_digest: record.scope_digest,
      tombstone_sequence: record.tombstone_sequence,
      tombstone_set_root: record.tombstone_set_root };
  }

  private exportExpectation(record: MemoryExportRecord): MemoryProofExpectation | undefined {
    if (record.request_id === null || record.request_digest === null
      || record.envelope_digest === null || record.provider_idempotency_key === null
      || record.delegation_id === null || record.delegation_digest === null) return undefined;
    return { provider_instance_id: record.provider_instance_id,
      request_id: record.request_id, request_digest: record.request_digest,
      envelope_digest: record.envelope_digest, idempotency_key: record.provider_idempotency_key,
      delegation_id: record.delegation_id, delegation_digest: record.delegation_digest,
      lane_id: record.lane_id, operation: "export", payload_digest: record.payload_digest,
      target_manifest_digest: record.target_manifest_digest, scope_digest: record.scope_digest,
      tombstone_sequence: record.tombstone_sequence,
      tombstone_set_root: record.tombstone_set_root };
  }
}

function assertNever(value: never): never {
  throw new JarvisError(`MEMORY_LIFECYCLE_OBSERVATION_INVALID:${String(value)}`);
}
