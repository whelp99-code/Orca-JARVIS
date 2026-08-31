import { randomUUID, type KeyObject } from "node:crypto";
import type { AuthorityDb } from "./db.js";
import { JarvisError } from "./db.js";
import type { SecondBrainWriteOutcome, SecondBrainWriteRequestAdapter } from "./second-brain-adapter-types.js";
import { createMemoryReadFence, MEMORY_TOMBSTONE_GENESIS_ROOT, parseResolvedMemoryTarget,
  type MemoryReadFenceV1, type ResolvedMemoryTargetV2 } from "./second-brain-effect-v2.js";
import type { SecondBrainOutcome, SecondBrainTransport } from "./second-brain-transport.js";
import { SecondBrainTransportError } from "./second-brain-transport.js";

export type SecondBrainEffectServiceOptions = {
  readonly authority: AuthorityDb; readonly transport: SecondBrainTransport;
  readonly writer: SecondBrainWriteRequestAdapter; readonly clock: () => Date;
  readonly provider_instance_id: string; readonly signing_key_id: string; readonly private_key: KeyObject;
  readonly fence_ttl_ms?: number; readonly nonce?: () => string;
};
export type SecondBrainEffectServiceResult<T> =
  | { readonly kind: "data"; readonly value: T }
  | { readonly kind: "invalid" | "unavailable" | "uncertain"; readonly code: string };
export type ResolveMemoryTargetInput = {
  readonly page_id: string; readonly exact_record: string; readonly source_identity_full: string;
  readonly sensitivity?: "public" | "personal" | "sensitive" | "restricted";
  readonly source_owner_class?: "provider_owned" | "external_read_only"; readonly source_owner_id?: string;
};

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype ? value as Record<string, unknown> : undefined;
}
function text(value: unknown): string | undefined { return typeof value === "string" && value.length > 0 ? value : undefined; }
export class SecondBrainEffectService {
  private readonly ttl: number;
  constructor(private readonly options: SecondBrainEffectServiceOptions) {
    this.ttl = options.fence_ttl_ms ?? 60_000;
    if (!options.provider_instance_id || !options.signing_key_id || !Number.isSafeInteger(this.ttl)
      || this.ttl < 1_000 || this.ttl > 300_000 || options.private_key.asymmetricKeyType !== "ed25519") {
      throw new JarvisError("MEMORY_EFFECT_SERVICE_CONFIG_INVALID");
    }
  }
  submit(value: unknown): Promise<SecondBrainWriteOutcome> { return this.options.writer.write(value); }
  private highWater(): { readonly sequence: number; readonly set_root: string } {
    const row = this.options.authority.db.prepare(
      "SELECT sequence,set_root FROM memory_tombstone_chain ORDER BY sequence DESC LIMIT 1",
    ).get() as { sequence: number; set_root: string } | undefined;
    return row ?? { sequence: 0, set_root: MEMORY_TOMBSTONE_GENESIS_ROOT };
  }
  private fence(purpose: "memory_read" | "memory_status" | "memory_resolve",
    high: { readonly sequence: number; readonly set_root: string }, at: Date): MemoryReadFenceV1 {
    const milliseconds = at.getTime(); if (!Number.isFinite(milliseconds)) throw new JarvisError("MEMORY_READ_FENCE_INVALID");
    const stamp = at.toISOString();
    return createMemoryReadFence({ provider_instance_id: this.options.provider_instance_id, purpose,
      operation: purpose === "memory_read" ? "read" : purpose === "memory_status" ? "status" : "resolve",
      tombstone_sequence: high.sequence, tombstone_set_root: high.set_root, issued_at: stamp, not_before: stamp,
      expires_at: new Date(milliseconds + this.ttl).toISOString(),
      nonce: `memfence-nonce:${this.options.nonce?.() ?? randomUUID()}`, signing_key_id: this.options.signing_key_id },
    this.options.private_key);
  }
  readFence(purpose: "memory_read" | "memory_status" | "memory_resolve", at = this.options.clock()): MemoryReadFenceV1 {
    return this.fence(purpose, this.highWater(), at);
  }
  readFenceFactory(): (at: Date) => MemoryReadFenceV1 {
    return at => this.readFence("memory_read", at);
  }
  private async call(method: "sb_generation_status" | "sb_request_status" | "sb_resolve_memory_target",
    arguments_: Readonly<Record<string, unknown>>): Promise<SecondBrainEffectServiceResult<Record<string, unknown>>> {
    try {
      const outcome: SecondBrainOutcome = await this.options.transport.call(method, arguments_);
      if (outcome.kind === "data") return { kind: "data", value: outcome.value };
      return outcome.kind === "error" ? { kind: "unavailable", code: outcome.code }
        : { kind: "invalid", code: "SECOND_BRAIN_EFFECT_RESULT_INVALID" };
    } catch (error) {
      if (!(error instanceof SecondBrainTransportError)) throw error;
      return { kind: error.disposition === "uncertain" ? "uncertain" : "unavailable", code: error.code };
    }
  }
  async generationStatus(): Promise<SecondBrainEffectServiceResult<Readonly<Record<string, unknown>>>> {
    const result = await this.call("sb_generation_status", { read_fence: this.readFence("memory_status") });
    if (result.kind !== "data") return result;
    const value = record(result.value); const high = this.highWater();
    if (value === undefined || value.schema_version !== 1 || value.provider_instance_id !== this.options.provider_instance_id
      || text(value.generation_id) === undefined || text(value.generation_manifest_digest) === undefined
      || value.tombstone_sequence !== high.sequence || value.tombstone_set_root !== high.set_root
      || value.pointer_health !== "healthy" || value.journal_health !== "healthy"
      || !Array.isArray(value.features) || !value.features.includes("memory_effect_write_v2")) {
      return { kind: "invalid", code: "SECOND_BRAIN_GENERATION_STATUS_INVALID" };
    }
    return { kind: "data", value: Object.freeze({ ...value }) };
  }
  async requestStatus(requestId: string): Promise<SecondBrainEffectServiceResult<Readonly<Record<string, unknown>>>> {
    if (!/^memeff:req:v2:[0-9a-f]{64}$/.test(requestId)) return { kind: "invalid", code: "MEMORY_EFFECT_REQUEST_ID_INVALID" };
    const local = this.highWater();
    const result = await this.call("sb_request_status", { request_id: requestId,
      read_fence: this.fence("memory_status", local, this.options.clock()) });
    if (result.kind !== "data") return result;
    const value = record(result.value);
    if (value === undefined || value.schema_version !== 1 || value.request_id !== requestId || typeof value.state !== "string") {
      return { kind: "invalid", code: "SECOND_BRAIN_REQUEST_STATUS_INVALID" };
    }
    return { kind: "data", value: Object.freeze({ ...value }) };
  }
  async resolveTarget(input: ResolveMemoryTargetInput): Promise<SecondBrainEffectServiceResult<ResolvedMemoryTargetV2>> {
    if (!input.page_id || !input.exact_record || !/^[0-9a-f]{64}$/.test(input.source_identity_full)) {
      return { kind: "invalid", code: "MEMORY_EFFECT_TARGET_SELECTOR_INVALID" };
    }
    const at = this.options.clock();
    const result = await this.call("sb_resolve_memory_target", {
      page_id: input.page_id, exact_record: input.exact_record, source_identity_full: input.source_identity_full,
      sensitivity: input.sensitivity ?? "personal", source_owner_class: input.source_owner_class ?? "provider_owned",
      source_owner_id: input.source_owner_id ?? "provider", read_fence: this.readFence("memory_resolve", at),
    });
    if (result.kind !== "data") return result;
    const target = parseResolvedMemoryTarget(result.value, this.options.provider_instance_id, at);
    if (target === undefined) return { kind: "invalid", code: "SECOND_BRAIN_TARGET_RESULT_INVALID" };
    try {
      this.options.authority.db.prepare(
        `INSERT OR IGNORE INTO memory_resolved_target_metadata(
          target_id,target_digest,provider_instance_id,generation_id,generation_manifest_digest,
          page_content_digest,source_identity_digest,content_identity_digest,citation_identity_digest,
          keyed_subject_digest,sensitivity,source_owner_class,source_owner_id_digest,resolved_at,expires_at,created_at
         ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(target.target_id, target.target_digest, target.provider_instance_id, target.generation_id,
        target.generation_manifest_digest, target.page_content_digest, target.source_identity_full,
        target.content_identity_full, target.citation_identity_full, target.subject_digest,
        target.sensitivity, target.source_owner_class, target.source_owner_id_digest,
        target.resolved_at, target.expires_at, at.toISOString());
      const prior = this.options.authority.db.prepare(
        "SELECT target_digest FROM memory_resolved_target_metadata WHERE target_id=?",
      ).get(target.target_id) as { target_digest: string } | undefined;
      if (prior?.target_digest !== target.target_digest) {
        return { kind: "invalid", code: "MEMORY_EFFECT_TARGET_REPLAY_CONFLICT" };
      }
    } catch { return { kind: "invalid", code: "MEMORY_EFFECT_TARGET_STORE_FAILED" }; }
    return { kind: "data", value: target };
  }
  async restartForGeneration(expectedGenerationId: string): Promise<SecondBrainEffectServiceResult<Readonly<Record<string, unknown>>>> {
    try { await this.options.transport.restart(); }
    catch (error) {
      return { kind: "unavailable", code: error instanceof SecondBrainTransportError
        ? error.code : "SECOND_BRAIN_RESTART_FAILED" };
    }
    const status = await this.generationStatus();
    if (status.kind !== "data" || status.value.generation_id !== expectedGenerationId) {
      return { kind: "invalid", code: "SECOND_BRAIN_GENERATION_RESTART_MISMATCH" };
    }
    return status;
  }

  rollback(value: unknown): SecondBrainEffectServiceResult<never> {
    void value;
    return { kind: "invalid", code: "ROLLBACK_REQUIRES_GENERATION_AUTHORITY" };
  }
}
