import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthorityDb } from "../../src/db.js";
import {
  countForbiddenContentMatches,
  loadForbiddenContentIdentities,
  persistForbiddenContentIdentities,
} from "../../src/memory-forbidden-content.js";
import { tempDb } from "../helpers.js";

describe("restart-safe forbidden content identities", () => {
  it.each([
    '짧은\n"기억"\\경로\t',
    '\u0000\b\f\r\n\t"\\',
    '🚢\n"업무"\\끝',
    '가\n"나"\\'.repeat(30),
  ])("detects raw and twice serialized content: case %#", async (memory) => {
    const root = mkdtempSync(join(tmpdir(), "jarvis-forbidden-json-"));
    const db = new AuthorityDb(join(root, "authority.sqlite"));
    try {
      await db.migrate();
      db.db.pragma("foreign_keys=OFF");
      const identities = persistForbiddenContentIdentities(db, {
        purge_id: "purge:json", material: [Buffer.from(memory)],
        observed_at: "2026-09-08T00:00:00.000Z",
      });
      const one = JSON.stringify({ prompt: memory });
      const two = JSON.stringify({ request: one });
      for (const stored of [memory, one, two]) {
        expect(countForbiddenContentMatches(Buffer.from(stored), identities)).toBeGreaterThan(0);
      }
      expect(countForbiddenContentMatches(Buffer.from('unrelated "내용"'), identities)).toBe(0);
      expect(JSON.stringify(loadForbiddenContentIdentities(db))).not.toContain(memory);
    } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
  });

  it("does not derive replacement-character identities from malformed UTF-8", async () => {
    const root = mkdtempSync(join(tmpdir(), "jarvis-forbidden-binary-"));
    const db = new AuthorityDb(join(root, "authority.sqlite"));
    try {
      await db.migrate();
      db.db.pragma("foreign_keys=OFF");
      const binary = Buffer.from([0xff, 0xc3, 0x28, 0x0a, 0x22, 0x5c]);
      const identities = persistForbiddenContentIdentities(db, {
        purge_id: "purge:binary", material: [binary, binary, Buffer.alloc(0)],
        observed_at: "2026-09-08T00:00:00.000Z",
      });
      expect(identities).toHaveLength(1);
      expect(countForbiddenContentMatches(binary, identities)).toBe(1);
      const lossy = binary.toString("utf8");
      for (const stored of [lossy, JSON.stringify(lossy)]) {
        expect(countForbiddenContentMatches(Buffer.from(stored), identities)).toBe(0);
      }
      persistForbiddenContentIdentities(db, {
        purge_id: "purge:binary", material: [binary], observed_at: "2026-09-08T00:00:00.000Z",
      });
      expect(loadForbiddenContentIdentities(db)).toEqual(identities);
    } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
  });

  it("finds embedded forbidden bytes from content-free persisted fingerprints", async () => {
    // Given: one runtime-only value reduced to digest and rolling-window metadata.
    const db = new AuthorityDb(tempDb());
    await db.migrate();
    try {
      const canary = Buffer.from("runtime-only-forbidden-memory-value");
      db.db.pragma("foreign_keys=OFF");
      persistForbiddenContentIdentities(db, { purge_id: "purge:test", material: [canary],
        observed_at: "2026-08-31T00:00:00.000Z" });
      db.db.pragma("foreign_keys=ON");
      const identities = loadForbiddenContentIdentities(db);

      // When: a later process scans bytes without receiving the original value.
      const matches = countForbiddenContentMatches(Buffer.concat([
        Buffer.from("before:"), canary, Buffer.from(":after"),
      ]), identities);

      // Then: the embedded value is found while unrelated bytes remain clean.
      expect({ identities: identities.length, matches,
        unrelated: countForbiddenContentMatches(Buffer.from("unrelated"), identities) })
        .toEqual({ identities: 1, matches: 1, unrelated: 0 });
    } finally {
      db.close();
    }
  });
});
