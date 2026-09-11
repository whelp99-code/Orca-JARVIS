import { expect, it } from "vitest";
import { RecordingModelTransport } from "../../src/index.js";
import { createProductionMemoryReference } from "../../src/memory-reference-production.js";
import { assemblePersonalContext } from "../../src/index.js";
import { contextAssemblerInput, CONTEXT_NOW } from "../fixtures/context-assembler-input.js";
import { cancellationResultFixture } from "../fixtures/memory-cancellation-result.js";
import { providerSurfaceInventory, reingressGuardObservations } from "../fixtures/memory-surface-observations.js";

it("reselects memories into the selected session after compaction", async () => {
  const f = await cancellationResultFixture();
  try {
    await f.runtime.compactor.compact({
      lane: "correction",
      lane_id: f.record.lane_id,
      target_manifest_digest: f.intent.original_delegation.target_manifest_digest,
      scope_digest: f.intent.original_delegation.scope_digest,
      tombstone: { sequence: f.intent.tombstone.sequence, set_root: f.intent.tombstone.set_root },
      provider_inventory: providerSurfaceInventory(),
      reingress_guards: reingressGuardObservations(),
    });
    const db = f.runtime.authority;
    const transport = new RecordingModelTransport();
    const produced = createProductionMemoryReference(db, {
      projection_key: Buffer.alloc(32, 7),
      model_transport: transport,
      transport: { call: async () => undefined as never, close: async () => undefined } as never,
    });
    const input = contextAssemblerInput();
    for (const observation of (input as { observations?: unknown[] }).observations ?? []) {
      db.persistObservation(observation, CONTEXT_NOW);
    }
    const snapshot = assemblePersonalContext(input);
    const memory = snapshot.evidence.find(item => item.kind === "confirmed_memory");
    if (memory === undefined) throw new Error("memory");
    const delivered = await produced.reselectAndDeliver(input, [{
      memory_ref: snapshot.payload.included_memory_refs[0] ?? memory.evidence_id,
      evidence_id: memory.evidence_id,
      source_id: memory.source_id,
      digest: memory.digest,
      observed_at: memory.observed_at,
      fresh_until: snapshot.expires_at,
    }], CONTEXT_NOW, "compacted-session");
    expect(delivered.capture.session_id).toBe("compacted-session");
    expect(transport.sent).toHaveLength(1);
    expect(transport.sent[0]?.session_id).toBe("compacted-session");
  } finally {
    await f.close();
  }
});
