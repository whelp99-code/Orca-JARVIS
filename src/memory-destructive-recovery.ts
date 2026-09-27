import { z } from "zod";
import { JarvisError } from "./db.js";
import { MemoryEffectSpool } from "./memory-effect-spool.js";
import { MemoryTombstoneChain } from "./memory-tombstone-chain.js";
import { parseCorrectionSpool, recordCorrectionDispatchOutcome } from "./memory-correction-dispatch.js";
import { MemoryCorrectionStore } from "./memory-correction-store.js";
import { MemoryDeletionStore } from "./memory-deletion-store.js";
import { MemoryDestructiveDispatchCursor } from "./memory-destructive-dispatch.js";
import { MemoryDeletionPayloadSchema, MemoryEffectScopeSchema, ResolvedMemoryTargetSchema } from "./memory-effect-write-zod.js";
import { memoryExpectedPrior } from "./memory-target-values.js";
import { publishMemorySuppression } from "./memory-suppression-events.js";
import type { MemorySagaRuntime } from "./memory-saga-runtime.js";
import { createMemoryEffectWriteRequest, memoryEffectDigest, parseMemoryEffectAccepted } from "./second-brain-effect-v2.js";

const preparationSchema = z.object({
  lane: z.enum(["correction", "deletion"]), lane_id: z.string(),
  spool_locator: z.string(), spool_digest: z.string(), target_manifest_digest: z.string(),
  scope_digest: z.string(), provider_tombstone_sequence: z.number().int(),
  request_tombstone_sequence: z.number().int(), request_tombstone_set_root: z.string(),
  request_id: z.string(), request_digest: z.string(), envelope_digest: z.string(),
  provider_idempotency_key: z.string(), delegation_id: z.string(), delegation_digest: z.string(),
});
const deletionSpoolSchema = z.object({
  schema_version: z.literal(1), lane_id: z.string(), deletion_id: z.string(),
  provider_instance_id: z.string(), targets: z.array(ResolvedMemoryTargetSchema).min(1).max(64),
  scope: MemoryEffectScopeSchema, payload: MemoryDeletionPayloadSchema,
  created_at: z.string(), expires_at: z.string(), nonce: z.string(),
}).strict();

/** Resume only the already-authorized identity. Never redeem approval or append a tombstone. */
export async function resumeMemoryDestructiveEffect(runtime: MemorySagaRuntime, laneId: string): Promise<void> {
  const parsed = preparationSchema.safeParse(runtime.authority.db.prepare(
    "SELECT * FROM memory_effect_preparations WHERE lane_id=? AND state='approved'",
  ).get(laneId));
  if (!parsed.success) throw new JarvisError("MEMORY_DESTRUCTIVE_PREPARATION_INVALID");
  const prior = parsed.data;
  const spool = new MemoryEffectSpool(runtime.spool_root, runtime.authority);
  const raw = await spool.read(prior.spool_locator, prior.spool_digest);
  const staged = (() => {
    switch (prior.lane) {
      case "correction": {
        const value = parseCorrectionSpool(raw);
        return { ...value, operation: "correct" as const, payload: {
          content: value.content, content_digest: memoryEffectDigest("effect_content", { content: value.content }),
          content_bytes: Buffer.byteLength(value.content, "utf8"), disposition: "superseded" as const,
        } };
      }
      case "deletion": {
        const value = deletionSpoolSchema.safeParse(raw);
        if (!value.success) throw new JarvisError("MEMORY_DELETION_SPOOL_INVALID");
        return { ...value.data, operation: "forget" as const };
      }
    }
  })();
  const target = staged.targets[0];
  if (target === undefined) throw new JarvisError("MEMORY_DESTRUCTIVE_PREPARATION_INVALID");
  const chain = new MemoryTombstoneChain(runtime.authority, runtime.subject_key);
  const request = createMemoryEffectWriteRequest({ schema_version: 2, kind: "memory_effect",
    provider_instance_id: staged.provider_instance_id, lane: prior.lane, lane_id: laneId,
    operation: staged.operation, target_manifest_digest: prior.target_manifest_digest,
    targets: staged.targets, scope: staged.scope, scope_digest: prior.scope_digest,
    expected_prior: memoryExpectedPrior(target),
    tombstone_high_water: { sequence: prior.request_tombstone_sequence, set_root: prior.request_tombstone_set_root },
    tombstone_chain_delta: chain.delta(prior.provider_tombstone_sequence)
      .filter(entry => entry.sequence <= prior.request_tombstone_sequence),
    created_at: staged.created_at, expires_at: staged.expires_at, payload: staged.payload,
  }, { principal_id: "principal:owner", not_before: staged.created_at, nonce: staged.nonce,
    signing_key_id: runtime.signing_key_id }, runtime.private_key);
  if (staged.lane_id !== laneId || request.request_id !== prior.request_id
    || request.request_digest !== prior.request_digest || request.envelope_digest !== prior.envelope_digest
    || request.idempotency_key !== prior.provider_idempotency_key
    || request.delegation.delegation_id !== prior.delegation_id
    || request.delegation.delegation_digest !== prior.delegation_digest) {
    throw new JarvisError("MEMORY_DESTRUCTIVE_PREPARATION_REPLAY_CONFLICT");
  }
  const now = runtime.clock();
  const cursor = new MemoryDestructiveDispatchCursor(runtime.authority);
  publishMemorySuppression(runtime.authority, prior.request_tombstone_sequence, now);
  cursor.claim({ lane_id: laneId, lane: prior.lane, sequence: prior.request_tombstone_sequence,
    request_digest: prior.request_digest }, now);
  switch (prior.lane) {
    case "correction": {
      const store = new MemoryCorrectionStore(runtime.authority);
      const row = store.beginDispatch(`memcorr:v1:${prior.request_digest.slice(7)}`, now);
      const outcome = await runtime.writer.write(request);
      await recordCorrectionDispatchOutcome(store, spool, row, request, outcome, now);
      if (outcome.kind === "accepted" && outcome.schema_version === 2) cursor.accepted(laneId, now);
      return;
    }
    case "deletion": {
      const identity = z.object({ deletion_id: z.string() }).parse(staged);
      const store = new MemoryDeletionStore(runtime.authority);
      const row = store.begin(identity.deletion_id, now);
      const outcome = await runtime.writer.write(request);
      if (outcome.kind === "accepted" && outcome.schema_version === 2) {
        const accepted = parseMemoryEffectAccepted(outcome);
        if (accepted === undefined || accepted.request_id !== request.request_id
          || accepted.envelope_digest !== request.envelope_digest) {
          throw new JarvisError("MEMORY_DELETION_ACCEPTANCE_INVALID");
        }
        await spool.remove(laneId, prior.spool_locator, prior.spool_digest, "accepted", now);
        store.accepted(row.deletion_id, accepted, accepted.queue_locator, now);
        cursor.accepted(laneId, now);
      } else store.uncertain(row.deletion_id, "code" in outcome ? outcome.code : "MEMORY_DELETION_UNCERTAIN", now);
      return;
    }
  }
}
