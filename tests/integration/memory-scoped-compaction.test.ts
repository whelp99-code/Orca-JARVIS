import { expect, it } from "vitest";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { AuthorityDb } from "../../src/db.js";
import { buildFreshAuthority } from "../../src/memory-authority-fresh-builder.js";
import { MemoryManagedSurfaceScanner } from "../../src/memory-managed-surface-scanner.js";
import { settleMemoryScopedCompletion } from "../../src/memory-scoped-settlement.js";
import { completionObservationFixture } from "../fixtures/scoped-completion-observation.js";
import { closeMemoryDatabase } from "../fixtures/memory-candidate-store.js";
import { providerSurfaceInventory, reingressGuardObservations } from "../fixtures/memory-surface-observations.js";

it("counts scoped bindings, observations and settlement in the outbox inventory", async () => {
  const f = await completionObservationFixture();
  try {
    await settleMemoryScopedCompletion(f.options, f.leased.lease, f.client, () => f.at, {
      candidate_dispatch_spool_root: f.options.dispatch.roots.dispatch, candidate_review_spool_root: f.options.dispatch.roots.review });
    const layout = { spool_root: join(f.database.root, "inventory-spool"), state_root: join(f.database.root, "state"),
      dist_root: join(f.database.root, "dist"), backup_root: join(f.database.root, "backup"), restore_root: join(f.database.root, "restore") };
    for (const path of Object.values(layout)) mkdirSync(path, { mode: 0o700 });
    const inventory = await new MemoryManagedSurfaceScanner({ authority: f.database.authority, layout }).scan({
      provider: providerSurfaceInventory(), guards: reingressGuardObservations() });
    const entry = inventory.entries.find(row => row.surface_id === "outbox_attempts_events")!;
    const names = f.database.authority.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND (name LIKE 'memory_outbox%' OR name LIKE 'memory_reconciliation%' OR name LIKE 'memory_scoped%')").all() as { name: string }[];
    const count = names.reduce((n, row) => n + Number((f.database.authority.db.prepare('SELECT count(*) AS n FROM "' + row.name + '"').get() as { n: number }).n), 0);
    expect(entry.object_count).toBe(names.length);
    expect(entry.row_count).toBe(count);
  } finally { closeMemoryDatabase(f.database); }
});

it.each(["candidate", "both"])("removes scoped dependents for %s in a fresh database and preserves the original", async mode => {
  const f = await completionObservationFixture();
  try {
    await settleMemoryScopedCompletion(f.options, f.leased.lease, f.client, () => f.at, {
      candidate_dispatch_spool_root: f.options.dispatch.roots.dispatch, candidate_review_spool_root: f.options.dispatch.roots.review });
    const path = join(f.database.root, "fresh.sqlite");
    const result = await buildFreshAuthority(f.database.authority, path, { blocked_projections: [
      ...(mode === "both" ? [{ kind: "outbox", id: f.dispatch.outbox_id, component_id: f.dispatch.outbox_id }] : []),
      { kind: "candidate", id: f.candidate.candidate_id, component_id: f.candidate.candidate_id },
    ], sensitive_material: [] });
    expect(result.foreign_key_errors).toBe(0);
    const fresh = new AuthorityDb(path);
    try {
      for (const table of ["memory_scoped_settlements", "memory_scoped_completion_observations", "memory_scoped_outbox_bindings", "memory_outbox", "memory_candidates"]) {
        expect(fresh.db.prepare('SELECT count(*) AS n FROM "' + table + '"').get()).toEqual({ n: 0 });
        expect(f.database.authority.db.prepare('SELECT count(*) AS n FROM "' + table + '"').get()).toEqual({ n: 1 });
      }
      expect(fresh.db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      expect(fresh.db.prepare("SELECT count(*) AS n FROM control_command_requests").get())
        .toEqual(f.database.authority.db.prepare("SELECT count(*) AS n FROM control_command_requests").get());
    } finally { fresh.close(); }
  } finally { closeMemoryDatabase(f.database); }
});
