import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { expect, it, vi } from "vitest";
import { MemoryAuthorityCompactor } from "../../src/memory-authority-compactor.js";
import { AuthorityDb } from "../../src/db.js";
import { AuthorityDatabaseRuntime } from "../../src/authority-database-runtime.js";
import { MemoryManagedSurfaceScanner } from "../../src/memory-managed-surface-scanner.js";
import * as cancellationPersistence from "../../src/memory-cancellation-compaction.js";
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

it("compacts a cancelled correction with its signed result and actual local scans, without provider inventory", async () => {
  const f = await cancellationResultFixture();
  try {
    const store = new MemoryCorrectionCancellationResultStore(f.db, f.runtime.clock);
    store.record(f.record.correction_id, f.result);
    const inode = statSync(f.db.filename).ino;
    const result = await f.runtime.compactor.compactCancellation(f.record.correction_id);
    expect(result).toMatchObject({ scope: "jarvis_cancellation_local_compaction", result_digest: f.result.result_digest,
      local: { observed_surface_count: 20 } });
    expect(statSync(f.db.filename).ino).not.toBe(inode);
    expect(existsSync(f.spoolPath)).toBe(false);
    expect(await f.runtime.compactor.recoverCancellation(f.record.correction_id)).toEqual(result);
    const reopened = new AuthorityDatabaseRuntime(new AuthorityDb(f.db.filename), {
      registry_root: join(f.root, "reopened-registry"), watchdog_ms: 5000,
    });
    try { expect(reopened.activeGeneration().generation).toBe(result.result_generation); }
    finally { await reopened.close(); }
    f.db.db.prepare("UPDATE memory_provider_proof_keys SET state='revoked'").run();
    await expect(f.runtime.compactor.recoverCancellation(f.record.correction_id)).rejects.toThrow();
    f.db.db.prepare("UPDATE memory_provider_proof_keys SET state='active'").run();
    expect(store.get(f.record.correction_id)).toEqual(f.result);
    expect(f.db.db.prepare("SELECT count(*) AS n FROM memory_compaction_inputs").get()).toEqual({ n: 0 });
    expect(f.db.db.prepare("SELECT count(*) AS n FROM memory_compaction_receipts").get()).toEqual({ n: 0 });
    expect(f.db.db.prepare("SELECT state FROM memory_purge_jobs").get()).toEqual({ state: "verifying" });
    expect(f.db.db.prepare("SELECT accepted_through_sequence FROM memory_effect_dispatch_cursor").get()).toEqual({ accepted_through_sequence: 0 });
  } finally { await f.close(); }
});


it("recovers after physical replacement but before local receipt persistence", async () => {
  const f = await cancellationResultFixture();
  const original = cancellationPersistence.completeCancellationCompaction;
  const spy = vi.spyOn(cancellationPersistence, "completeCancellationCompaction").mockImplementationOnce(() => {
    throw new Error("STOP_AFTER_LOCAL_SCAN");
  }).mockImplementation(original);
  try {
    new MemoryCorrectionCancellationResultStore(f.db, f.runtime.clock).record(f.record.correction_id, f.result);
    await expect(f.runtime.compactor.compactCancellation(f.record.correction_id)).rejects.toThrow("STOP_AFTER_LOCAL_SCAN");
    expect(existsSync(f.spoolPath)).toBe(false);
    const receipt = await f.runtime.compactor.recoverCancellation(f.record.correction_id);
    expect(await f.runtime.compactor.recoverCancellation(f.record.correction_id)).toEqual(receipt);
    expect(f.db.db.prepare("SELECT count(*) AS n FROM memory_cancellation_compaction_receipts").get()).toEqual({ n: 1 });
    expect(() => f.db.db.exec("DELETE FROM memory_cancellation_compaction_receipts")).toThrow("immutable");
    expect(() => f.db.db.exec("UPDATE memory_cancellation_compaction_inputs SET result_digest='bad'")).toThrow("immutable");
  } finally { spy.mockRestore(); await f.close(); }
});

it("rejects absent or currently revoked provider results before starting local compaction", async () => {
  const f = await cancellationResultFixture();
  try {
    await expect(f.runtime.compactor.compactCancellation(f.record.correction_id)).rejects.toThrow("MEMORY_CANCELLATION_RESULT_REQUIRED");
    new MemoryCorrectionCancellationResultStore(f.db, f.runtime.clock).record(f.record.correction_id, f.result);
    f.db.db.prepare("UPDATE memory_provider_proof_keys SET state='revoked'").run();
    await expect(f.runtime.compactor.compactCancellation(f.record.correction_id)).rejects.toThrow();
    expect(f.db.db.prepare("SELECT count(*) AS n FROM memory_purge_jobs").get()).toEqual({ n: 0 });
    expect(existsSync(f.spoolPath)).toBe(true);
  } finally { await f.close(); }
});

it.each(["before_build", "after_disposal"] as const)("rebuilds the same cancellation after %s interruption", async point => {
  const f = await cancellationResultFixture();
  const spy = point === "before_build"
    ? vi.spyOn(freshBuilder, "buildFreshAuthority").mockRejectedValueOnce(new Error("STOP_BEFORE_SWAP"))
    : vi.spyOn(f.runtime.compactor as any, "swap").mockRejectedValueOnce(new Error("STOP_BEFORE_SWAP"));
  try {
    new MemoryCorrectionCancellationResultStore(f.db, f.runtime.clock).record(f.record.correction_id, f.result);
    const inode = statSync(f.db.filename).ino;
    await expect(f.runtime.compactor.compactCancellation(f.record.correction_id)).rejects.toThrow("STOP_BEFORE_SWAP");
    expect(statSync(f.db.filename).ino).toBe(inode);
    expect(existsSync(f.spoolPath)).toBe(point === "before_build");
    const result = await f.runtime.compactor.recoverCancellation(f.record.correction_id);
    expect(statSync(f.db.filename).ino).not.toBe(inode);
    expect(await f.runtime.compactor.recoverCancellation(f.record.correction_id)).toEqual(result);
    expect(f.db.db.prepare("SELECT count(*) AS n FROM memory_purge_jobs").get()).toEqual({ n: 1 });
    expect(f.db.db.prepare("SELECT count(*) AS n FROM memory_cancellation_compaction_inputs").get()).toEqual({ n: 1 });
    expect(f.db.db.prepare("SELECT count(*) AS n FROM memory_cancellation_compaction_receipts").get()).toEqual({ n: 1 });
    expect(f.db.db.prepare("SELECT accepted_through_sequence FROM memory_effect_dispatch_cursor").get()).toEqual({ accepted_through_sequence: 0 });
  } finally { spy.mockRestore(); await f.close(); }
});


it("rejects a changed recovery layout before rebuilding and preserves the original input", async () => {
  const f = await cancellationResultFixture();
  const spy = vi.spyOn(freshBuilder, "buildFreshAuthority").mockRejectedValueOnce(new Error("STOP_BEFORE_SWAP"));
  try {
    new MemoryCorrectionCancellationResultStore(f.db, f.runtime.clock).record(f.record.correction_id, f.result);
    await expect(f.runtime.compactor.compactCancellation(f.record.correction_id)).rejects.toThrow("STOP_BEFORE_SWAP");
    const before = f.db.db.prepare("SELECT * FROM memory_cancellation_compaction_inputs").all();
    const layout = { spool_root: f.runtime.spool_root, state_root: join(f.root, "different-state"),
      dist_root: join(f.root, "dist"), backup_root: join(f.root, "backups"), restore_root: join(f.root, "restore") };
    const changed = new MemoryAuthorityCompactor({ runtime: f.databaseRuntime, layout, clock: f.runtime.clock,
      scanner: new MemoryManagedSurfaceScanner({ authority: f.db, layout }) });
    await expect(changed.recoverCancellation(f.record.correction_id)).rejects.toThrow("MEMORY_CANCELLATION_REBUILD_BINDING_INVALID");
    expect(f.db.db.prepare("SELECT * FROM memory_cancellation_compaction_inputs").all()).toEqual(before);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(existsSync(f.spoolPath)).toBe(true);
    await f.runtime.compactor.recoverCancellation(f.record.correction_id);
  } finally { spy.mockRestore(); await f.close(); }
});

it("recovers a replacement whose post-rename runtime metadata was never written", async () => {
  const f = await cancellationResultFixture();
  const spy = vi.spyOn(f.databaseRuntime, "observeOldInode").mockImplementationOnce(() => {
    throw new Error("STOP_AFTER_RENAME");
  });
  let replacement: AuthorityDatabaseRuntime | undefined;
  try {
    new MemoryCorrectionCancellationResultStore(f.db, f.runtime.clock).record(f.record.correction_id, f.result);
    const before = statSync(f.db.filename).ino;
    await expect(f.runtime.compactor.compactCancellation(f.record.correction_id)).rejects.toThrow("STOP_AFTER_RENAME");
    expect(statSync(f.db.filename).ino).not.toBe(before);
    const retired = readdirSync(dirname(f.db.filename)).filter(name => name.endsWith(".retired"));
    expect(retired).toHaveLength(1);
    expect(statSync(join(dirname(f.db.filename), retired[0]!)).ino).toBe(before);
    replacement = new AuthorityDatabaseRuntime(f.db, { registry_root: join(f.root, "replacement-registry"), watchdog_ms: 5000 });
    const layout = { spool_root: f.runtime.spool_root, state_root: join(f.root, "state"), dist_root: join(f.root, "dist"),
      backup_root: join(f.root, "backups"), restore_root: join(f.root, "restore") };
    const compactor = new MemoryAuthorityCompactor({ runtime: replacement, layout, clock: f.runtime.clock,
      scanner: new MemoryManagedSurfaceScanner({ authority: f.db, layout }) });
    const receipt = await compactor.recoverCancellation(f.record.correction_id);
    expect(readdirSync(dirname(f.db.filename)).filter(name => name.endsWith(".retired"))).toEqual([]);
    expect(await compactor.recoverCancellation(f.record.correction_id)).toEqual(receipt);
    expect(f.db.db.prepare("SELECT count(*) AS n FROM memory_cancellation_compaction_receipts").get()).toEqual({ n: 1 });
  } finally { spy.mockRestore(); await replacement?.close(); await f.close(); }
});
