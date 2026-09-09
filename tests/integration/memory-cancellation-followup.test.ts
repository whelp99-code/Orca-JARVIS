import { createPublicKey } from "node:crypto";
import { expect, it } from "vitest";
import { cancellationResultFixture } from "../fixtures/memory-cancellation-result.js";
import { dispatchFollowupCorrection } from "../fixtures/memory-followup-correction.js";
import { MemoryCorrectionCancellationResultStore } from "../../src/memory-correction-cancellation-result-store.js";
import { memoryEffectDigest, requireMemoryEffectWriteRequest, type MemoryEffectWriteRequestV2 } from "../../src/second-brain-effect-v2.js";

// Includes full physical reconstruction before follow-up dispatch; no production deadline change.
it("uses real confirmation and dispatch APIs to publish seq2 after cancellation settlement", async () => {
  const f = await cancellationResultFixture();
  try {
    new MemoryCorrectionCancellationResultStore(f.db, f.runtime.clock).record(f.record.correction_id, f.result);
    await f.runtime.compactor.compactCancellation(f.record.correction_id);
    await f.runtime.compactor.settleCancellation(f.record.correction_id);
    const { target_id: _id, target_digest: _digest, ...core } = f.staged.targets[0];
    void _id; void _digest;
    core.page_id = "wiki/followup";
    core.content_identity_full = "9".repeat(64);
    const digest = memoryEffectDigest("target", core);
    const target = { ...core, target_id: `sbtarget:v1:${digest.slice(7)}`, target_digest: digest };
    const emitted: MemoryEffectWriteRequestV2[] = [];
    const writer = { write: async (value: unknown) => {
      const request = requireMemoryEffectWriteRequest(value, { now: f.runtime.clock(), expectedProvider: "provider:fixture",
        delegationKeys: new Map([[f.runtime.signing_key_id, createPublicKey(f.runtime.private_key)]]) });
      emitted.push(request);
      return { schema_version: 2 as const, kind: "accepted" as const, state: "pending" as const,
        request_id: request.request_id, request_digest: request.request_digest, envelope_digest: request.envelope_digest,
        idempotency_key: request.idempotency_key, lane: request.lane, operation: request.operation,
        accepted_at: f.runtime.clock().toISOString(), queue_locator: `pending/${request.request_id}.v2.json`,
        request_file_digest: `sha256:${"1".repeat(64)}`, replayed: false, capability_verified: true as const,
        tombstone_sequence: request.tombstone_high_water.sequence, tombstone_set_root: request.tombstone_high_water.set_root,
        provider_instance_id: request.provider_instance_id };
    } };
    f.runtime.provider.generationStatus = async () => ({ kind: "data", value: {
      tombstone_sequence: 1, tombstone_set_root: f.intent.tombstone.set_root } });
    const followup = await dispatchFollowupCorrection(f.db, { ...f.runtime, writer }, target, f.staged.scope, "Followup correction");
    expect(emitted).toHaveLength(1);
    expect(emitted[0]!.tombstone_chain_delta).toHaveLength(1);
    expect(emitted[0]!.tombstone_chain_delta[0]).toMatchObject({ sequence: 2, previous_root: f.intent.tombstone.set_root });
    expect(followup.record.tombstone_sequence).toBe(2);
    expect(followup.record.state).toBe("reconciling");
    expect(f.db.db.prepare("SELECT accepted_through_sequence FROM memory_effect_dispatch_cursor").get()).toEqual({ accepted_through_sequence: 2 });
    expect(f.writer.calls).toHaveLength(0);
  } finally { await f.close(); }
}, 15_000);
