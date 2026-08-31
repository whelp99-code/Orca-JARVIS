import { z } from "zod";
import type { AuthorityDb } from "./db.js";
import { JarvisError } from "./db.js";
import type { MemoryCorrectionRecord } from "./memory-correction-store.js";
import { MemoryCorrectionStore } from "./memory-correction-store.js";
import { MemoryEffectSpool } from "./memory-effect-spool.js";
import { MemoryEffectScopeSchema, ResolvedMemoryTargetSchema } from "./memory-effect-write-zod.js";
import type { SecondBrainWriteOutcome } from "./second-brain-adapter-types.js";
import { parseMemoryEffectAccepted, type MemoryEffectWriteRequestV2,
  type ResolvedMemoryTargetV2 } from "./second-brain-effect-v2.js";

const correctionSpool = z.object({
  schema_version: z.literal(1),
  lane_id: z.string(),
  candidate_id: z.string(),
  provider_instance_id: z.string(),
  targets: z.tuple([ResolvedMemoryTargetSchema]),
  scope: MemoryEffectScopeSchema,
  content: z.string(),
  created_at: z.string(),
  expires_at: z.string(),
  nonce: z.string(),
}).strict();

export function parseCorrectionSpool(value: unknown): z.infer<typeof correctionSpool> {
  const parsed = correctionSpool.safeParse(value);
  if (!parsed.success) throw new JarvisError("MEMORY_CORRECTION_SPOOL_INVALID");
  return parsed.data;
}

export async function recordCorrectionDispatchOutcome(
  store: MemoryCorrectionStore,
  spool: MemoryEffectSpool,
  record: MemoryCorrectionRecord,
  request: MemoryEffectWriteRequestV2,
  outcome: SecondBrainWriteOutcome,
  now: Date,
): Promise<void> {
  if (outcome.kind === "accepted" && outcome.schema_version === 2) {
    const accepted = parseMemoryEffectAccepted(outcome);
    if (accepted === undefined || accepted.request_id !== request.request_id
      || accepted.envelope_digest !== request.envelope_digest) {
      throw new JarvisError("MEMORY_CORRECTION_ACCEPTANCE_INVALID");
    }
    if (record.spool_locator === null) throw new JarvisError("MEMORY_CORRECTION_SPOOL_MISSING");
    await spool.remove(record.lane_id, record.spool_locator, record.spool_digest, "accepted", now);
    store.accepted(record.correction_id, accepted, accepted.queue_locator, now);
    return;
  }
  const code = "code" in outcome ? outcome.code : "MEMORY_CORRECTION_DISPATCH_UNCERTAIN";
  store.uncertain(record.correction_id, code, now);
}

export function persistCorrectionTargets(
  authority: AuthorityDb,
  targets: readonly ResolvedMemoryTargetV2[],
  now: Date,
): void {
  const insert = authority.db.prepare(
    `INSERT OR IGNORE INTO memory_resolved_target_metadata(
      target_id,target_digest,provider_instance_id,generation_id,generation_manifest_digest,
      page_content_digest,source_identity_digest,content_identity_digest,citation_identity_digest,
      keyed_subject_digest,sensitivity,source_owner_class,source_owner_id_digest,resolved_at,expires_at,created_at
     ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  );
  for (const target of targets) {
    insert.run(target.target_id, target.target_digest, target.provider_instance_id,
      target.generation_id, target.generation_manifest_digest, target.page_content_digest,
      target.source_identity_full, target.content_identity_full, target.citation_identity_full,
      target.subject_digest, target.sensitivity, target.source_owner_class,
      target.source_owner_id_digest, target.resolved_at, target.expires_at, now.toISOString());
  }
}
