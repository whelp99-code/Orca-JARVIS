import { canonicalize } from "./canonical.js";
import {
  createMemoryReadFence,
  memoryEffectDigest,
  parseResolvedMemoryTarget,
  type MemoryEffectScopeV2,
  type MemoryReadFenceV1,
  type ResolvedMemoryTargetV2,
} from "./second-brain-effect-v2.js";

export { createMemoryReadFence, parseResolvedMemoryTarget };
export type { MemoryReadFenceV1, ResolvedMemoryTargetV2 };

export function memoryTargetManifestDigest(
  targets: readonly ResolvedMemoryTargetV2[],
): string {
  const ordered = [...targets].sort((left, right) => left.target_digest.localeCompare(right.target_digest));
  return memoryEffectDigest("target_manifest", { targets: ordered });
}

export function memoryTargetScopeDigest(
  targets: readonly ResolvedMemoryTargetV2[],
  scope: MemoryEffectScopeV2,
): string {
  const targetDigests = targets.map(target => target.target_digest).sort();
  return memoryEffectDigest("target_scope", { target_digests: targetDigests, scope });
}

export function memoryExpectedPrior(target: ResolvedMemoryTargetV2) {
  return Object.freeze({
    provider_instance_id: target.provider_instance_id,
    generation_id: target.generation_id,
    generation_manifest_digest: target.generation_manifest_digest,
    vault_head: target.vault_head,
    vault_tree: target.vault_tree,
    page_blob_oid: target.page_blob_oid,
    page_content_digest: target.page_content_digest,
    citation_identity_full: target.citation_identity_full,
  });
}

export function sameMemoryGeneration(targets: readonly ResolvedMemoryTargetV2[]): boolean {
  if (targets.length === 0) return false;
  const first = targets[0];
  if (first === undefined) return false;
  const identity = canonicalize({
    provider_instance_id: first.provider_instance_id,
    generation_id: first.generation_id,
    generation_manifest_digest: first.generation_manifest_digest,
    vault_head: first.vault_head,
    vault_tree: first.vault_tree,
  });
  return targets.every(target => canonicalize({
    provider_instance_id: target.provider_instance_id,
    generation_id: target.generation_id,
    generation_manifest_digest: target.generation_manifest_digest,
    vault_head: target.vault_head,
    vault_tree: target.vault_tree,
  }) === identity);
}
