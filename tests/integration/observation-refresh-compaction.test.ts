import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { AuthorityDb } from "../../src/db.js";
import { buildFreshAuthority } from "../../src/memory-authority-fresh-builder.js";
import { ObservationRefreshStore } from "../../src/observation-refresh-store.js";
import { observationInput, OBSERVATION_CHECKED_AT as at } from "../fixtures/personal-observation-input.js";

it("preserves historical receipt while erased source observations make it unavailable after reconstruction", async () => {
  const root = mkdtempSync(join(tmpdir(), "jarvis-refresh-compaction-"));
  const db = new AuthorityDb(join(root, "source.sqlite"), "migrations");
  const scope = { members: [{ source_id: "src:pos:v1:orca:local", worktree_id: "worktree-local" },
  { source_id: "src:pos:v1:orca:jm-server", worktree_id: "worktree-jm-server" }] };
  try {
    await db.migrate();
    const receipt = new ObservationRefreshStore(db, scope).admit({ key: "compaction", capped: false, collections: [{ source_id: "src:pos:v1:orca:local", worktree_id: "worktree-local", state: "completed" as const },
      { source_id: "src:pos:v1:orca:jm-server", worktree_id: "worktree-jm-server", state: "completed" as const }],
      observations: { ...observationInput(), portfolios: [] } }, at);
    const source = db.db.prepare("SELECT observation_id FROM personal_observations LIMIT 1").get() as { observation_id: string };
    const path = join(root, "fresh.sqlite");
    const result = await buildFreshAuthority(db, path, {
      blocked_projections: [{ kind: "observation", id: source.observation_id, component_id: "root" }], sensitive_material: [],
    });
    expect(result.foreign_key_errors).toBe(0);
    const fresh = new AuthorityDb(path, "migrations");
    try {
      const before = fresh.db.serialize();
      expect(new ObservationRefreshStore(fresh, scope).read(receipt.refresh_id, at))
        .toMatchObject({ state: "unavailable", reason: "source_missing" });
      expect(fresh.db.serialize().equals(before)).toBe(true);
      expect(fresh.db.prepare("SELECT COUNT(*) n FROM observation_refresh_receipts").get()).toEqual({ n: 1 });
      expect(fresh.db.prepare("SELECT COUNT(*) n FROM personal_observations").get()).toEqual({ n: 1 });
    } finally { fresh.close(); }
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});
