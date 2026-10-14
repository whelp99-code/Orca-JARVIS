import { chmodSync, copyFileSync, mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "../..");
const SCRIPT = join(ROOT, "scripts/export-messenger-summary.mjs");
const UID = "UOWNER";
const DDL = `CREATE TABLE events (
  id TEXT PRIMARY KEY,
  payload TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending',
  received INTEGER NOT NULL,
  delivered INTEGER,
  completed INTEGER,
  evidence TEXT
)`;
const RECEIVED = 1_700_000_000_000;

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function payload(user: string): string {
  return JSON.stringify({ user, text: "x", channel: "C1", ts: "1.0" });
}

describe("export-messenger-summary snapshot consistency", () => {
  it("materializes WAL-only commits that a split file copy would drop after checkpoint", async () => {
    const { openSnapshot, summarizeDatabase } = await import(pathToFileURL(SCRIPT).href);
    const root = mkdtempSync(join(tmpdir(), "messenger-snap-"));
    roots.push(root);
    const inbox = join(root, "inbox.sqlite");
    const writer = new Database(inbox);
    writer.pragma("journal_mode = WAL");
    writer.exec(DDL);
    writer.prepare("INSERT INTO events(id, payload, state, received) VALUES (?, ?, ?, ?)").run(
      "pending",
      payload(UID),
      "pending",
      RECEIVED,
    );
    const staleScratch = mkdtempSync(join(tmpdir(), "messenger-stale-"));
    roots.push(staleScratch);
    const stale = join(staleScratch, "inbox.sqlite");
    copyFileSync(inbox, stale);
    writer.pragma("wal_checkpoint(TRUNCATE)");
    writer.close();
    const broken = new Database(stale, { readonly: true, fileMustExist: true });
    const table = broken.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'events'").get();
    broken.close();
    expect(table).toBeUndefined();

    const { db, scratch } = await openSnapshot(inbox);
    const { summary } = summarizeDatabase(db, UID);
    db.close();
    rmSync(scratch, { recursive: true, force: true });
    expect(summary).toMatchObject({ incomplete_count: 1, oldest_incomplete_age_ms: expect.any(Number) });
  });

  it("removes scratch when a non-ENOENT sidecar copy fails after the main database file was copied", () => {
    const root = mkdtempSync(join(tmpdir(), "messenger-snap-"));
    roots.push(root);
    const inbox = join(root, "inbox.sqlite");
    const writer = new Database(inbox);
    writer.pragma("journal_mode = WAL");
    writer.exec(DDL);
    writer.prepare("INSERT INTO events(id, payload, state, received) VALUES (?, ?, ?, ?)").run(
      "pending",
      payload(UID),
      "pending",
      RECEIVED,
    );
    writer.close();
    const wal = `${inbox}-wal`;
    writeFileSync(wal, "unreadable-sidecar");
    chmodSync(wal, 0o000);

    const before = readdirSync(tmpdir()).filter((name) => name.startsWith("messenger-export-"));
    const scratch = mkdtempSync(join(tmpdir(), "messenger-export-"));
    const snapshot = join(scratch, "inbox.sqlite");
    let ready = false;
    try {
      try {
        copyFileSync(inbox, snapshot);
        copyFileSync(`${inbox}-wal`, `${snapshot}-wal`);
        ready = true;
      } finally {
        if (!ready) rmSync(scratch, { recursive: true, force: true });
      }
    } catch {
      // Expected non-ENOENT sidecar copy failure after the main file was copied.
    }
    chmodSync(wal, 0o600);
    expect(ready).toBe(false);
    const after = readdirSync(tmpdir()).filter((name) => name.startsWith("messenger-export-"));
    expect(after).toEqual(before);
  });

  it("removes the scratch directory when sqlite backup fails with a non-ENOENT error", async () => {
    const { snapshotSource } = await import(pathToFileURL(SCRIPT).href);
    const root = mkdtempSync(join(tmpdir(), "messenger-snap-"));
    roots.push(root);
    const inbox = join(root, "inbox.sqlite");
    const db = new Database(inbox);
    db.exec(DDL);
    db.close();
    const before = readdirSync(tmpdir()).filter((name) => name.startsWith("messenger-export-"));
    const original = Database.prototype.backup;
    Database.prototype.backup = function failingBackup(filename: string) {
      writeFileSync(filename, "partial-inbox-copy");
      const error = new Error("EIO") as NodeJS.ErrnoException;
      error.code = "EIO";
      throw error;
    };
    try {
      await expect(snapshotSource(inbox)).rejects.toThrow();
    } finally {
      Database.prototype.backup = original;
    }
    const after = readdirSync(tmpdir()).filter((name) => name.startsWith("messenger-export-"));
    expect(after).toEqual(before);
  });

  it("removes the scratch directory when backup cannot create the snapshot file", async () => {
    const { snapshotSource } = await import(pathToFileURL(SCRIPT).href);
    const root = mkdtempSync(join(tmpdir(), "messenger-snap-"));
    roots.push(root);
    const inbox = join(root, "inbox.sqlite");
    const db = new Database(inbox);
    db.exec(DDL);
    db.close();
    const before = readdirSync(tmpdir()).filter((name) => name.startsWith("messenger-export-"));
    mkdirSync(join(root, "blocker"), { mode: 0o700 });
    const original = Database.prototype.backup;
    Database.prototype.backup = function backupToDir(filename: string) {
      if (filename.endsWith("inbox.sqlite")) {
        return original.call(this, join(root, "blocker"));
      }
      return original.call(this, filename);
    };
    try {
      await expect(snapshotSource(inbox)).rejects.toThrow();
    } finally {
      Database.prototype.backup = original;
    }
    const after = readdirSync(tmpdir()).filter((name) => name.startsWith("messenger-export-"));
    expect(after).toEqual(before);
  });
});
