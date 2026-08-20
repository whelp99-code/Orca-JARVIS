import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthorityDb } from "../../src/db.js";
import { SqlitePerformanceMemory } from "../../src/sqlite-performance-memory.js";
import { DEFAULT_ROUTING_POLICY } from "../../src/budgeted-evolution-engine.js";

const tempRoots: string[] = [];
const tempDb = () => {
  const root = mkdtempSync(join(tmpdir(), "budgeted-evolution-"));
  tempRoots.push(root);
  return join(root, "authority.sqlite");
};

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("SqlitePerformanceMemory", () => {
  it("persists champion performance across memory instances", async () => {
    const db = new AuthorityDb(tempDb());
    await db.migrate();
    const memory = new SqlitePerformanceMemory(db);
    for (let i = 0; i < 3; i += 1) {
      memory.record("code-review", { candidateId: "codex", candidateFingerprint: "sha256:codex-v1", output: {}, cost: 0.1, latencyMs: 100 }, { candidateId: "codex", quality: 0.9, safety: 0.95, efficiency: 0.8 }, true);
    }
    const reloaded = new SqlitePerformanceMemory(db);
    expect(reloaded.champion("code-review", DEFAULT_ROUTING_POLICY)?.candidateId).toBe("codex");
    expect(reloaded.list("code-review")[0]?.runs).toBe(3);
    db.close();
  });

  it("keeps task keys isolated", async () => {
    const db = new AuthorityDb(tempDb());
    await db.migrate();
    const memory = new SqlitePerformanceMemory(db);
    memory.seed({ taskKey: "a", candidateId: "x", candidateFingerprint: "sha256:x-v1", runs: 3, successes: 3, avgScore: 0.9, avgCost: 0, avgLatencyMs: 0, updatedAt: new Date().toISOString() });
    expect(memory.list("b")).toEqual([]);
    db.close();
  });

  it("applies append-only migration 029 without replacing negative evidence", async () => {
    const db = new AuthorityDb(tempDb());
    await db.migrate();
    const migrationIds = (db.db.prepare("SELECT id FROM schema_migrations ORDER BY id").all() as Array<{ id: string }>).map(row => row.id);
    const tables = (db.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('negative_evidence','evolution_shadow_observations') ORDER BY name").all() as Array<{ name: string }>).map(row => row.name);

    expect(migrationIds).toContain("028_negative_evidence.sql");
    expect(migrationIds).toContain("029_budgeted_evolution_shadow.sql");
    expect(tables).toEqual(["evolution_shadow_observations", "negative_evidence"]);
    db.close();
  });

  it("appends immutable observations and isolates candidate fingerprints", async () => {
    const path = tempDb();
    const firstDb = new AuthorityDb(path);
    await firstDb.migrate();
    const secondDb = new AuthorityDb(path);
    await secondDb.migrate();
    const first = new SqlitePerformanceMemory(firstDb);
    const second = new SqlitePerformanceMemory(secondDb);
    const evaluation = { candidateId: "codex", quality: 0.9, safety: 0.95, efficiency: 0.8 };

    first.record("code-review", { candidateId: "codex", candidateFingerprint: "sha256:codex-v1", output: {}, cost: 0.1, latencyMs: 100 }, evaluation, true);
    second.recordFailure("code-review", { candidateId: "codex", candidateFingerprint: "sha256:codex-v2", output: {}, cost: 0.2, latencyMs: 200 });
    first.record("code-review", { candidateId: "codex", candidateFingerprint: "sha256:codex-v1", output: {}, cost: 0.1, latencyMs: 100 }, evaluation, true);

    const rows = first.list("code-review");
    expect(rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ candidateId: "codex", candidateFingerprint: "sha256:codex-v1", runs: 2, successes: 2 }),
      expect.objectContaining({ candidateId: "codex", candidateFingerprint: "sha256:codex-v2", runs: 1, successes: 0 }),
    ]));
    expect(firstDb.db.prepare("SELECT COUNT(*) AS count FROM evolution_shadow_observations").get()).toEqual({ count: 3 });
    expect(() => firstDb.db.prepare("UPDATE evolution_shadow_observations SET outcome='verified'").run()).toThrow("immutable evolution observation");

    secondDb.close();
    firstDb.close();
  });
});
