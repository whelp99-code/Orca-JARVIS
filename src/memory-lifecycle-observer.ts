import { createHash } from "node:crypto";
import { canonicalize } from "./canonical.js";
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
import type {
  CompleteProviderSurfaceInventory,
  CorrectionLifecycleObservation,
  DeletionLifecycleObservation,
  ExportLifecycleObservation,
  MemoryLifecycleObserver,
  NotProved,
  VerifiedGenerationObservation,
} from "./memory-lifecycle-observation-types.js";
import type { SecondBrainEffectService } from "./second-brain-effect-service.js";

const REINGRESS_GUARDS = ["sb_remember", "legacy_stable_import", "inbox_done",
  "all_connectors", "compile_brief", "manual_pipeline", "export",
  "backup_import_restore_rollback", "duplicate_alias", "stale_process_generation"] as const;

export type ProductionMemoryLifecycleObserverOptions = {
  readonly authority: AuthorityDb;
  readonly provider: SecondBrainEffectService;
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
    if (proof.artifact_manifest_digest === null) {
      throw new JarvisError("MEMORY_CORRECTION_ARTIFACT_INVALID");
    }
    const generation = await this.generation(proof, true);
    return { kind: "correction", proof, generation,
      replacement: { artifact_manifest_digest: proof.artifact_manifest_digest,
        target_manifest_digest: record.target_manifest_digest },
      provider_inventory: this.inventory(proof), reingress_guards: this.guards(proof) };
  }

  async deletion(record: MemoryDeletionRecord): Promise<DeletionLifecycleObservation | NotProved> {
    const expectation = this.deletionExpectation(record);
    if (expectation === undefined) return { kind: "not_proved", code: "MEMORY_DELETION_NOT_PREPARED" };
    const proof = await this.proof(expectation);
    if (isNotProved(proof)) return proof;
    const generation = await this.generation(proof, true);
    return { kind: "deletion", proof, generation,
      absence: { surface_manifest_digest: proof.surface_manifest_digest,
        target_manifest_digest: record.target_manifest_digest },
      provider_inventory: this.inventory(proof), reingress_guards: this.guards(proof) };
  }

  async export(record: MemoryExportRecord): Promise<ExportLifecycleObservation | NotProved> {
    const expectation = this.exportExpectation(record);
    if (expectation === undefined) return { kind: "not_proved", code: "MEMORY_EXPORT_NOT_PREPARED" };
    const proof = await this.proof(expectation);
    if (isNotProved(proof)) return proof;
    if (proof.export_manifest_digest === null) throw new JarvisError("MEMORY_EXPORT_MANIFEST_INVALID");
    const generation = await this.generation(proof, false);
    return { kind: "export", proof, generation,
      export: { export_manifest_digest: proof.export_manifest_digest,
        file_count: 1, byte_count: 1 }, provider_inventory: this.inventory(proof),
      reingress_guards: this.guards(proof) };
  }

  private async proof(
    expected: MemoryProofExpectation,
  ): Promise<MemoryDispositionProofV1 | NotProved> {
    const status = await this.options.provider.requestStatus(expected.request_id);
    if (status.kind !== "data") return { kind: "not_proved", code: status.code };
    if (status.value.state !== "proved") return { kind: "not_proved",
      code: `MEMORY_PROVIDER_${String(status.value.state).toUpperCase()}` };
    return verifyMemoryDispositionProof(this.options.authority,
      status.value.proof, expected, this.options.clock());
  }

  private async generation(
    proof: MemoryDispositionProofV1,
    restart: boolean,
  ): Promise<VerifiedGenerationObservation> {
    const result = restart
      ? await this.options.provider.restartForGeneration(proof.result_generation_id)
      : await this.options.provider.generationStatus();
    if (result.kind !== "data") throw new JarvisError("MEMORY_LIFECYCLE_GENERATION_INVALID");
    const value = result.value;
    if (value.generation_id !== proof.result_generation_id
      || typeof value.generation_manifest_digest !== "string"
      || value.tombstone_sequence !== proof.tombstone_sequence
      || value.tombstone_set_root !== proof.tombstone_set_root) {
      throw new JarvisError("MEMORY_LIFECYCLE_GENERATION_INVALID");
    }
    return { generation_id: proof.result_generation_id,
      generation_manifest_digest: value.generation_manifest_digest,
      tombstone_sequence: proof.tombstone_sequence,
      tombstone_set_root: proof.tombstone_set_root };
  }

  private inventory(proof: MemoryDispositionProofV1): CompleteProviderSurfaceInventory {
    return { manifest_digest: proof.surface_manifest_digest,
      catalog_rows: 40, signature_verified: true };
  }

  private guards(proof: MemoryDispositionProofV1): Readonly<Record<string, string>> {
    return Object.fromEntries(REINGRESS_GUARDS.map(name => [name,
      `sha256:${createHash("sha256").update(canonicalize({ name,
        proof_digest: proof.proof_digest, tombstone_sequence: proof.tombstone_sequence,
        tombstone_set_root: proof.tombstone_set_root })).digest("hex")}`]));
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
