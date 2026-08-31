import type { MemoryReadFenceV1 } from "./second-brain-effect-v2.js";
import type { SecondBrainReadMethod } from "./second-brain-transport.js";

const GENERATION_METADATA = [
  "provider_instance_id",
  "generation_id",
  "generation_manifest_digest",
  "vault_head",
  "vault_tree",
  "tombstone_sequence",
  "tombstone_set_root",
] as const;

const GENERATION_METADATA_KEYS = new Set<string>(GENERATION_METADATA);

const GENERATION_BOUND_METHODS: readonly SecondBrainReadMethod[] = [
  "sb_search",
  "sb_read_page",
  "sb_recent_changes",
  "sb_open_conflicts",
];

export function bindSecondBrainGenerationRead(
  value: Readonly<Record<string, unknown>>,
  fence: MemoryReadFenceV1 | undefined,
  method: SecondBrainReadMethod,
): Readonly<Record<string, unknown>> | undefined {
  if (!GENERATION_BOUND_METHODS.includes(method)) return value;
  const present = GENERATION_METADATA.filter(key => Object.hasOwn(value, key));
  if (present.length === 0) {
    return fence !== undefined && fence.tombstone_sequence > 0 ? undefined : value;
  }
  if (present.length !== GENERATION_METADATA.length
    || typeof value.provider_instance_id !== "string"
    || !/^sbgen:v1:[0-9a-f]{64}$/.test(String(value.generation_id))
    || !/^sha256:[0-9a-f]{64}$/.test(String(value.generation_manifest_digest))
    || !/^[0-9a-f]{40}$/.test(String(value.vault_head))
    || !/^[0-9a-f]{40}$/.test(String(value.vault_tree))
    || !Number.isSafeInteger(value.tombstone_sequence)
    || !/^sha256:[0-9a-f]{64}$/.test(String(value.tombstone_set_root))) return undefined;
  if (fence === undefined) {
    if (value.tombstone_sequence !== 0) return undefined;
  } else if (value.provider_instance_id !== fence.provider_instance_id
    || value.tombstone_sequence !== fence.tombstone_sequence
    || value.tombstone_set_root !== fence.tombstone_set_root) return undefined;
  return Object.freeze(Object.fromEntries(
    Object.entries(value).filter(([key]) => !GENERATION_METADATA_KEYS.has(key)),
  ));
}
