import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { MemoryManagedSurfaceScanner } from "../../src/memory-managed-surface-scanner.js";
import * as freshBuilder from "../../src/memory-authority-fresh-builder.js";
import { collectCancellationMaterial } from "../../src/memory-cancellation-material.js";
import { MemoryCorrectionCancellationResultStore } from "../../src/memory-correction-cancellation-result-store.js";
import { cancellationResultFixture } from "../fixtures/memory-cancellation-result.js";
import { providerSurfaceInventory, reingressGuardObservations } from "../fixtures/memory-surface-observations.js";

it("preserves cancellation evidence across physical DB replacement under the existing full inventory contract", async () => {
  const f = await cancellationResultFixture();
  try {
    const store = new MemoryCorrectionCancellationResultStore(f.db, f.runtime.clock);
    store.record(f.record.correction_id, f.result);
    const scanner = new MemoryManagedSurfaceScanner({ authority: f.db, layout: {
      spool_root: f.runtime.spool_root, state_root: join(f.root, "state"), dist_root: join(f.root, "dist"),
      backup_root: join(f.root, "backups"), restore_root: join(f.root, "restore"),
    } });
    expect(() => scanner.scanLocal()).toThrow("MEMORY_LOCAL_SCAN_MATERIAL_UNPROVED");
    const oldInode = statSync(f.db.filename).ino;
    const copy = join(f.root, "state", "cancelled-copy.json");
    const unrelated = join(f.root, "state", "unrelated.txt");
    writeFileSync(copy, JSON.stringify({ content: f.staged.content }), { mode: 0o600 });
    writeFileSync(unrelated, "keep unrelated material", { mode: 0o600 });
    // Synthetic provider/guard observations exercise the existing compactor contract.
    // They are not evidence supplied by a real cancellation provider result.
    const compacted = await f.runtime.compactor.compact({ lane: "correction", lane_id: f.record.lane_id,
      target_manifest_digest: f.intent.original_delegation.target_manifest_digest,
      scope_digest: f.intent.original_delegation.scope_digest,
      tombstone: { sequence: f.intent.tombstone.sequence, set_root: f.intent.tombstone.set_root },
      provider_inventory: providerSurfaceInventory(), reingress_guards: reingressGuardObservations() });
    expect(compacted).toMatchObject({ integrity_check: "ok", foreign_key_errors: 0, old_database_disposed: true,
      inventory: { expected_surface_count: 70, observed_surface_count: 70 } });
    expect(statSync(f.db.filename).ino).not.toBe(oldInode);
    expect([f.spoolPath, copy].map(existsSync)).toEqual([false, false]);
    expect(readFileSync(unrelated, "utf8")).toBe("keep unrelated material");
    const local = scanner.scanLocal();
    expect(local).toMatchObject({ scope: "jarvis_managed_local_observation", expected_surface_count: 20, observed_surface_count: 20 });
    expect(local.entries.every(entry => entry.owner === "jarvis")).toBe(true);
    expect(Object.isFrozen(local) && Object.isFrozen(local.entries) && local.entries.every(Object.isFrozen)).toBe(true);
    writeFileSync(copy, JSON.stringify({ content: f.staged.content }), { mode: 0o600 });
    expect(() => scanner.scanLocal()).toThrow("MEMORY_LOCAL_SURFACE_INCOMPLETE");
    expect(store.get(f.record.correction_id)).toEqual(f.result);
    expect(await collectCancellationMaterial(f.db, f.runtime.spool_root, compacted.purge_id, f.runtime.clock())).toEqual([]);
    expect(f.db.db.prepare("SELECT accepted_through_sequence FROM memory_effect_dispatch_cursor").get())
      .toEqual({ accepted_through_sequence: 0 });
  } finally { await f.close(); }
});


it("rejects a runtime writer after fresh DB construction so key revocation cannot be silently lost", async () => {
  const f = await cancellationResultFixture();
  const build = freshBuilder.buildFreshAuthority;
  let observed: unknown;
  const spy = vi.spyOn(freshBuilder, "buildFreshAuthority").mockImplementation(async (...args) => {
    const result = await build(...args);
    try {
      await f.databaseRuntime.write(db => db.db.prepare("UPDATE memory_provider_proof_keys SET state='revoked'").run());
    } catch (error) { observed = error; }
    return result;
  });
  try {
    await f.runtime.compactor.compact({ lane: "correction", lane_id: f.record.lane_id,
      target_manifest_digest: f.intent.original_delegation.target_manifest_digest,
      scope_digest: f.intent.original_delegation.scope_digest,
      tombstone: { sequence: f.intent.tombstone.sequence, set_root: f.intent.tombstone.set_root },
      provider_inventory: providerSurfaceInventory(), reingress_guards: reingressGuardObservations() });
    expect(observed).toMatchObject({ code: "AUTHORITY_DATABASE_QUIESCING" });
    await f.databaseRuntime.write(db => db.db.prepare("UPDATE memory_provider_proof_keys SET state='revoked'").run());
    expect(f.db.db.prepare("SELECT state FROM memory_provider_proof_keys").all()).toEqual([{ state: "revoked" }]);
  } finally { spy.mockRestore(); await f.close(); }
});

it("drains an existing runtime writer before copying its committed state", async () => {
  const f = await cancellationResultFixture();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let entered!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const writer = f.databaseRuntime.write(async db => {
    entered(); await gate;
    db.db.prepare("UPDATE memory_provider_proof_keys SET state='revoked'").run();
  });
  try {
    await ready;
    const compaction = f.runtime.compactor.compact({ lane: "correction", lane_id: f.record.lane_id,
      target_manifest_digest: f.intent.original_delegation.target_manifest_digest,
      scope_digest: f.intent.original_delegation.scope_digest,
      tombstone: { sequence: f.intent.tombstone.sequence, set_root: f.intent.tombstone.set_root },
      provider_inventory: providerSurfaceInventory(), reingress_guards: reingressGuardObservations() });
    release();
    await Promise.all([writer, compaction]);
    expect(f.db.db.prepare("SELECT state FROM memory_provider_proof_keys").all()).toEqual([{ state: "revoked" }]);
  } finally { release(); await writer; await f.close(); }
});
