import type {
  SecondBrainGenerationBinding,
  SecondBrainReadOutcome,
} from "./second-brain-adapter-types.js";
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
export const SECOND_BRAIN_GENERATION_BINDING_KEY = "__generation_binding" as const;

const GENERATION_BOUND_METHODS: readonly SecondBrainReadMethod[] = [
  "sb_search",
  "sb_read_page",
  "sb_recent_changes",
  "sb_open_conflicts",
];
/** Per-provider-session read context: the fence, the method, and that session's
 *  first-seen unbound generation identity per method. */
export type SecondBrainGenerationReadContext = {
  readonly fence: MemoryReadFenceV1 | undefined;
  readonly method: SecondBrainReadMethod;
  readonly unbound_generations: Map<SecondBrainReadMethod, string>;
};

export function bindSecondBrainGenerationRead(
  value: Readonly<Record<string, unknown>>,
  context: SecondBrainGenerationReadContext,
): Readonly<Record<string, unknown>> | undefined {
  const { fence, method } = context;
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
    const identity = GENERATION_METADATA.map(key => String(value[key])).join("\0");
    const prior = context.unbound_generations.get(method);
    if (prior !== undefined && prior !== identity) return undefined;
    context.unbound_generations.set(method, identity);
  } else if (value.provider_instance_id !== fence.provider_instance_id
    || value.tombstone_sequence !== fence.tombstone_sequence
    || value.tombstone_set_root !== fence.tombstone_set_root) return undefined;
  const binding: SecondBrainGenerationBinding = {
    provider_instance_id: value.provider_instance_id,
    generation_id: String(value.generation_id),
    generation_manifest_digest: String(value.generation_manifest_digest),
    vault_head: String(value.vault_head),
    vault_tree: String(value.vault_tree),
    tombstone_sequence: Number(value.tombstone_sequence),
    tombstone_set_root: String(value.tombstone_set_root),
  };
  const content = Object.fromEntries(
    Object.entries(value).filter(([key]) => !GENERATION_METADATA_KEYS.has(key)),
  );
  const results = value["results"];
  const conflicts = value["conflicts"];
  const schema4 = Object.hasOwn(value, "records")
    || (Array.isArray(results) && results.some(item => typeof item === "object" && item !== null
      && Object.hasOwn(item, "record_id")))
    || (Array.isArray(conflicts) && conflicts.some(item => typeof item === "object" && item !== null
      && Object.hasOwn(item, "records")));
  return schema4 ? Object.freeze({ ...content,
    [SECOND_BRAIN_GENERATION_BINDING_KEY]: Object.freeze(binding) }) : Object.freeze(content);
}

export function secondBrainEvidenceGenerationMatches(
  outcome: SecondBrainReadOutcome,
  expected: SecondBrainGenerationBinding | undefined,
): boolean {
  if (outcome.kind !== "current" && outcome.kind !== "stale" && outcome.kind !== "conflicts") return false;
  const rows = outcome.kind === "conflicts"
    ? outcome.conflicts.flatMap(item => [item.left, item.right]) : outcome.evidence;
  const observed = rows.map(item => item.record?.generation).filter(item => item !== undefined);
  if (expected === undefined) return observed.length === 0;
  return observed.length > 0 && observed.every(item => JSON.stringify(item) === JSON.stringify(expected));
}

export function secondBrainGenerationBinding(
  value: Readonly<Record<string, unknown>>,
): SecondBrainGenerationBinding | undefined {
  const candidate = value[SECOND_BRAIN_GENERATION_BINDING_KEY];
  if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) return undefined;
  if (Object.keys(candidate).sort().join("\0") !== [...GENERATION_METADATA].sort().join("\0")) return undefined;
  const provider = Reflect.get(candidate, "provider_instance_id");
  const generation = Reflect.get(candidate, "generation_id");
  const manifest = Reflect.get(candidate, "generation_manifest_digest");
  const head = Reflect.get(candidate, "vault_head");
  const tree = Reflect.get(candidate, "vault_tree");
  const sequence = Reflect.get(candidate, "tombstone_sequence");
  const root = Reflect.get(candidate, "tombstone_set_root");
  if (typeof provider !== "string" || typeof generation !== "string"
    || typeof manifest !== "string" || typeof head !== "string" || typeof tree !== "string"
    || typeof sequence !== "number" || typeof root !== "string"
    || !/^sbgen:v1:[0-9a-f]{64}$/.test(generation)
    || !/^sha256:[0-9a-f]{64}$/.test(manifest) || !/^[0-9a-f]{40}$/.test(head)
    || !/^[0-9a-f]{40}$/.test(tree) || !Number.isSafeInteger(sequence)
    || !/^sha256:[0-9a-f]{64}$/.test(root)) return undefined;
  return { provider_instance_id: provider, generation_id: generation,
    generation_manifest_digest: manifest, vault_head: head, vault_tree: tree,
    tombstone_sequence: sequence, tombstone_set_root: root };
}
