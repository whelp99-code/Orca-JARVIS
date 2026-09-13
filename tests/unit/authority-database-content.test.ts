import Database from "better-sqlite3";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { authorityContentDigest, withAuthorityContentProbe } from "../../src/authority-database-content.js";

it("distinguishes SQL storage types and same-count changes, including row identity", () => {
  const db = new Database(":memory:");
  try {
    db.exec("CREATE TABLE values_under_test(value); INSERT INTO values_under_test VALUES(NULL)");
    const digests = new Set<string>([authorityContentDigest(db)]);
    for (const value of [1n, 1.0, "1", Buffer.from("1"), 9007199254740993n]) {
      db.prepare("UPDATE values_under_test SET value=?").run(value);
      digests.add(authorityContentDigest(db));
    }
    expect(digests.size).toBe(6);
    const before = authorityContentDigest(db);
    db.exec("UPDATE values_under_test SET rowid=2");
    expect(authorityContentDigest(db)).not.toBe(before);
    expect(db.inTransaction).toBe(false);
  } finally { db.close(); }
});

it("keeps equivalent snapshots stable across scan order and preserves the caller's transaction", () => {
  const db = new Database(":memory:");
  try {
    db.exec(`CREATE TABLE keyed(k TEXT PRIMARY KEY,value BLOB) WITHOUT ROWID;
      INSERT INTO keyed VALUES('a',x'00ff'),('b',NULL);
      CREATE TABLE ordinary(value); INSERT INTO ordinary VALUES('same'),('same');
      BEGIN EXCLUSIVE`);
    const before = authorityContentDigest(db);
    db.pragma("reverse_unordered_selects=ON");
    expect(authorityContentDigest(db)).toBe(before);
    expect(db.inTransaction).toBe(true);
    db.exec("DELETE FROM ordinary WHERE rowid=2");
    expect(authorityContentDigest(db)).not.toBe(before);
    db.exec("ROLLBACK");
    expect(authorityContentDigest(db)).toBe(before);
    db.exec("UPDATE keyed SET value=x'ff00' WHERE k='a'");
    expect(authorityContentDigest(db)).not.toBe(before);
  } finally { db.close(); }
});

it("includes schema changes and refuses unreadable row identity without leaving a transaction", () => {
  const db = new Database(":memory:");
  try {
    db.exec("CREATE TABLE ordinary(value)");
    const before = authorityContentDigest(db);
    db.exec("CREATE INDEX value_index ON ordinary(value)");
    expect(authorityContentDigest(db)).not.toBe(before);
    db.exec("CREATE TABLE hidden_identity(rowid, _rowid_, oid)");
    expect(() => authorityContentDigest(db)).toThrow("MEMORY_SOURCE_ROW_IDENTITY_UNREADABLE");
    expect(db.inTransaction).toBe(false);
  } finally { db.close(); }
});

it("never creates a missing source when opening a content probe", () => {
  const root = mkdtempSync(join(tmpdir(), "authority-content-"));
  const path = join(root, "absent.sqlite");
  try {
    expect(() => withAuthorityContentProbe(path, authorityContentDigest)).toThrow();
    expect(existsSync(path)).toBe(false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it("refuses virtual tables explicitly instead of silently omitting their content", () => {
  const db = new Database(":memory:");
  try {
    db.exec("CREATE VIRTUAL TABLE external_content USING fts5(content)");
    expect(() => authorityContentDigest(db)).toThrow("AUTHORITY_SOURCE_VIRTUAL_TABLE_UNSUPPORTED");
    expect(db.inTransaction).toBe(false);
  } finally { db.close(); }
});
