import Database from "better-sqlite3";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AuthorityDb } from "../../src/db.js";
import { countManagedMatches, disposeSensitiveManagedCopies } from "../../src/memory-compaction-external.js";
import {
  countForbiddenContentMatches, loadForbiddenContentIdentities, persistForbiddenContentIdentities,
} from "../../src/memory-forbidden-content.js";
import { MemoryManagedSurfaceScanner } from "../../src/memory-managed-surface-scanner.js";
import { providerSurfaceInventory, reingressGuardObservations } from "../fixtures/memory-surface-observations.js";

const MEMORY = '기억\n"A"\\B\t';
const AT = "2026-09-08T00:00:00.000Z";

describe("JSON memory copies in managed retention surfaces", () => {
  it("removes malformed raw bytes but preserves their lossy replacement-character rendering", () => {
    const root = mkdtempSync(join(tmpdir(), "jarvis-json-malformed-"));
    const layout = makeLayout(root);
    try {
      const raw = Buffer.from([0xff, 0x0a, 0x22, 0x5c]);
      const exact = join(layout.state_root, "exact.bin");
      const lossy = join(layout.state_root, "lossy.json");
      writeFileSync(exact, raw);
      writeFileSync(lossy, JSON.stringify({ prompt: raw.toString("utf8") }));
      expect(disposeSensitiveManagedCopies(layout, [raw])).toBe(1);
      expect(existsSync(exact)).toBe(false);
      expect(existsSync(lossy)).toBe(true);
      expect(raw).toEqual(Buffer.from([0xff, 0x0a, 0x22, 0x5c]));
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("disposes raw, JSONL and nested SQLite copies while preserving unrelated files", () => {
    const root = mkdtempSync(join(tmpdir(), "jarvis-json-disposal-"));
    const layout = makeLayout(root);
    try {
      const raw = join(layout.spool_root, "prompt.txt");
      const json = join(layout.state_root, "rollout.jsonl");
      const sqlite = join(layout.backup_root, "thread-history.sqlite");
      const restore = join(layout.restore_root, "restore.json");
      const unrelated = join(layout.state_root, "keep.json");
      writeFileSync(raw, MEMORY);
      writeFileSync(json, JSON.stringify({ prompt: MEMORY }) + "\n");
      writeSqlite(sqlite, JSON.stringify({ request: JSON.stringify({ prompt: MEMORY }) }));
      writeFileSync(restore, JSON.stringify({ request: JSON.stringify({ prompt: MEMORY }) }));
      writeFileSync(unrelated, JSON.stringify({ prompt: '기억 "unrelated"' }));
      expect(readFileSync(sqlite).includes(Buffer.from(MEMORY))).toBe(false);
      expect(countManagedMatches(layout, [Buffer.from(MEMORY)])).toBe(4);
      expect(disposeSensitiveManagedCopies(layout, [Buffer.from(MEMORY)])).toBe(4);
      expect([raw, json, sqlite, restore].map(existsSync)).toEqual([false, false, false, false]);
      expect(readFileSync(unrelated, "utf8")).toBe(JSON.stringify({ prompt: '기억 "unrelated"' }));
      expect(countManagedMatches(layout, [Buffer.from(MEMORY)])).toBe(0);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("rejects escaped reingress after reopening the authority without the original material", async () => {
    const root = mkdtempSync(join(tmpdir(), "jarvis-json-reingress-"));
    const layout = makeLayout(root);
    let authority = new AuthorityDb(join(root, "authority.sqlite"));
    try {
      await authority.migrate();
      authority.db.pragma("foreign_keys=OFF");
      const identities = persistForbiddenContentIdentities(authority, {
        purge_id: "purge:json-fixture", material: [Buffer.from(MEMORY)], observed_at: AT,
      });
      authority.db.pragma("foreign_keys=ON");
      expect(identities).toHaveLength(3);
      authority.close();
      authority = new AuthorityDb(join(root, "authority.sqlite"));
      expect(loadForbiddenContentIdentities(authority)).toEqual(identities);
      const scanner = new MemoryManagedSurfaceScanner({ authority, layout });
      const scan = () => scanner.scan({ provider: providerSurfaceInventory(), guards: reingressGuardObservations() });
      await expect(scan()).resolves.toMatchObject({ observed_surface_count: 70 });
      const copy = join(layout.restore_root, "thread-history.sqlite");
      writeSqlite(copy, JSON.stringify({ request: JSON.stringify({ prompt: MEMORY }) }));
      expect(countForbiddenContentMatches(readFileSync(copy), loadForbiddenContentIdentities(authority)))
        .toBeGreaterThan(0);
      await expect(scan()).rejects.toMatchObject({ code: "MEMORY_SURFACE_INVENTORY_INCOMPLETE" });
      rmSync(copy);
      await expect(scan()).resolves.toMatchObject({ observed_surface_count: 70 });
    } finally { authority.close(); rmSync(root, { recursive: true, force: true }); }
  });

  it("refuses escaped forbidden content in dist without removing the dist file", () => {
    const root = mkdtempSync(join(tmpdir(), "jarvis-json-dist-"));
    const layout = makeLayout(root);
    try {
      const copy = join(layout.dist_root, "unexpected.json");
      writeFileSync(copy, JSON.stringify({ prompt: MEMORY }));
      expect(() => disposeSensitiveManagedCopies(layout, [Buffer.from(MEMORY)]))
        .toThrowError(expect.objectContaining({ code: "MEMORY_DIST_RUNTIME_FIXTURE_MATCH" }));
      expect(existsSync(copy)).toBe(true);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

function makeLayout(root: string) {
  const layout = { spool_root: join(root, "spool"), state_root: join(root, "state"),
    dist_root: join(root, "dist"), backup_root: join(root, "backup"), restore_root: join(root, "restore") };
  for (const path of Object.values(layout)) mkdirSync(path, { mode: 0o700 });
  return layout;
}

function writeSqlite(path: string, value: string): void {
  const database = new Database(path);
  try {
    database.exec("CREATE TABLE history (prompt TEXT NOT NULL)");
    database.prepare("INSERT INTO history VALUES (?)").run(value);
  } finally { database.close(); }
}
