import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { MemoryProjectionAuthority } from "../../src/memory-projection-authority.js";
import { MemoryEffectSpool } from "../../src/memory-effect-spool.js";
import { createSecondBrainWriteRequestAdapter } from "../../src/second-brain-write-adapter.js";
import { correctionPreparedFixture } from "../fixtures/memory-correction-control.js";
import { createMemoryEffectWriteRequest, memoryEffectDigest } from "../../src/second-brain-effect-v2.js";

function deny(f: Awaited<ReturnType<typeof correctionPreparedFixture>>) {
  new MemoryProjectionAuthority(f.db).quarantineUnresolved({ kind: "dashboard_projection",
    id: f.candidate.candidate_id, component_id: f.candidate.candidate_id }, f.runtime.clock());
}

it("the acceptance fixture rejects a freshly signed mixed chain before recording a provider call", async () => {
  const f = await correctionPreparedFixture();
  try {
    await f.saga.dispatch(f.claim);
    const first = f.writer.calls[0]!; const prior = first.tombstone_chain_delta[0]!;
    const { tombstone_id, set_root, ...core } = prior; void tombstone_id; void set_root;
    const nextCore = { ...core, sequence: 2, previous_root: prior.set_root, operation: "forget" as const,
      lane_id: `memdel:req:v1:${"f".repeat(64)}` };
    const root = memoryEffectDigest("tombstone_chain", nextCore);
    const next = { ...nextCore, tombstone_id: `memtomb:v1:${root.slice(7)}`, set_root: root };
    const { request_id, request_digest, envelope_digest, idempotency_key, delegation, ...spec } = first;
    void request_id; void request_digest; void envelope_digest; void idempotency_key;
    const mixed = createMemoryEffectWriteRequest({ ...spec, tombstone_chain_delta: [prior, next],
      tombstone_high_water: { sequence: 2, set_root: root } }, { principal_id: "principal:owner",
      not_before: delegation.not_before, nonce: "mixed-chain", signing_key_id: delegation.signing_key_id }, f.runtime.private_key);
    expect(() => f.writer.write(mixed)).toThrow("EFFECT_TOMBSTONE_DELTA_INVALID");
    expect(f.writer.calls).toHaveLength(1);
  } finally { await f.close(); }
});

it.each(["before-prepare", "after-spool"] as const)("rejects %s without losing the existing preparation spool", async phase => {
  const f = await correctionPreparedFixture(); let restore: (() => void) | undefined;
  try {
    const names = readdirSync(f.runtime.spool_root); const path = join(f.runtime.spool_root, names[0]!);
    const bytes = readFileSync(path); const value = JSON.parse(bytes.toString());
    if (phase === "before-prepare") deny(f);
    else {
      const original = MemoryEffectSpool.prototype.write;
      const spy = vi.spyOn(MemoryEffectSpool.prototype, "write").mockImplementation(async function(this: MemoryEffectSpool, lane, value) {
        const result = await original.call(this, lane, value); deny(f); return result;
      }); restore = () => spy.mockRestore();
    }
    await expect(f.saga.prepare({ control_request_id: "suppressed-reprepare", candidate_id: f.candidate.candidate_id,
      provider_instance_id: value.provider_instance_id, targets: value.targets, scope: value.scope, content: value.content,
      requested_at: new Date(value.created_at), expires_at: new Date(value.expires_at), nonce: "replacement-nonce" }))
      .rejects.toMatchObject({ code: "MEMORY_CANDIDATE_SUPPRESSED" });
    expect(readFileSync(path)).toEqual(bytes); expect(readdirSync(f.runtime.spool_root)).toEqual(names);
    expect(f.db.db.prepare("SELECT COUNT(*) AS count FROM memory_effect_preparations").get()).toEqual({ count: 1 });
  } finally { restore?.(); await f.close(); }
});

it("rechecks after provider await before adding a tombstone or materialized correction", async () => {
  const f = await correctionPreparedFixture();
  try {
    const original = f.runtime.provider.generationStatus.bind(f.runtime.provider);
    f.runtime.provider.generationStatus = async () => { const result = await original(); deny(f); return result; };
    await expect(f.saga.dispatch(f.claim)).rejects.toMatchObject({ code: "MEMORY_CANDIDATE_SUPPRESSED" });
    expect(f.writer.calls).toHaveLength(0);
    for (const table of ["memory_tombstone_chain", "memory_correction_requests", "memory_correction_attempts"]) {
      expect(f.db.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()).toEqual({ count: 0 });
    }
  } finally { await f.close(); }
});

it("rejects after the tombstone barrier without spending the global cursor", async () => {
  const f = await correctionPreparedFixture();
  try {
    const original = f.runtime.barriers.reach.bind(f.runtime.barriers);
    f.runtime.barriers.reach = async input => { const result = await original(input); deny(f); return result; };
    await expect(f.saga.dispatch(f.claim)).rejects.toMatchObject({ code: "MEMORY_CANDIDATE_SUPPRESSED" });
    expect(f.writer.calls).toHaveLength(0);
    expect(f.db.db.prepare("SELECT COUNT(*) AS count FROM memory_correction_attempts").get()).toEqual({ count: 0 });
    expect(f.db.db.prepare("SELECT active_lane_id,fence FROM memory_effect_dispatch_cursor").get())
      .toEqual({ active_lane_id: null, fence: 0 });
    expect(f.db.db.prepare("SELECT state FROM memory_correction_requests").get()).toEqual({ state: "queued" });
    expect((await f.runtime.provider.generationStatus()).kind).toBe("invalid");
    expect(f.runtime.provider.readFence("memory_read").tombstone_sequence).toBe(1);
  } finally { await f.close(); }
});

it("checks valid V2 input in the direct adapter after dispatch and keeps observation possible", async () => {
  const f = await correctionPreparedFixture(); let calls = 0;
  try {
    const adapter = createSecondBrainWriteRequestAdapter({ call: async () => {
      calls++; return { kind: "no_data", reason: "empty_result" }; },
    restart: async () => {}, close: async () => {}, diagnostics: () => [] }, f.db, f.runtime.clock);
    f.runtime.writer.write = async request => {
      expect(await adapter.write(request)).toEqual({ kind: "invalid", code: "SECOND_BRAIN_WRITE_RESULT_INVALID" });
      expect(calls).toBe(1); deny(f);
      const rejected = await adapter.write(request);
      expect(rejected).toEqual({ kind: "invalid", code: "SECOND_BRAIN_WRITE_AUTHORITY_INVALID" });
      expect(calls).toBe(1); return rejected;
    };
    const record = await f.saga.dispatch(f.claim);
    expect(record.state).toBe("reconciling");
    expect((await f.saga.reconcile(record.correction_id)).state).toBe("reconciling");
    expect(calls).toBe(1);
  } finally { await f.close(); }
});
