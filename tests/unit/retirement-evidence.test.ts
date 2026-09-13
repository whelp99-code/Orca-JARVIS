import Database from "better-sqlite3";
import { chmodSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { retirementState, retirementUnchanged } from "../../src/local-observation-retention-publish.js";

describe("retirement evidence", () => {
  it("detects a checkpointed same-size update even when both timestamps are identical", () => {
    const root = mkdtempSync(join(tmpdir(), "jarvis-retirement-coarse-"));
    const database = join(root, "authority.sqlite");
    const fixed = new Date("2026-09-01T00:00:00.000Z");
    try {
      const source = new Database(database);
      source.exec("CREATE TABLE value_under_test(value); INSERT INTO value_under_test VALUES(1)");
      source.close();
      utimesSync(database, fixed, fixed);
      const metadata = statSync(database, { bigint: true });
      const before = retirementState(database);
      const writer = new Database(database);
      writer.exec("UPDATE value_under_test SET value=2");
      writer.close();
      utimesSync(database, fixed, fixed);
      const after = statSync(database, { bigint: true });
      expect([after.size, after.mtimeNs]).toEqual([metadata.size, metadata.mtimeNs]);
      expect(retirementUnchanged(before, retirementState(database))).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("keeps the verdict stable when only the rebuildable SHM cache is recreated", () => {
    const root = mkdtempSync(join(tmpdir(), "jarvis-retirement-shm-"));
    const database = join(root, "authority.sqlite");
    try {
      writeFileSync(database, "unchanged body");
      writeFileSync(`${database}-wal`, "unchanged nonempty WAL");
      const before = retirementState(database);
      writeFileSync(`${database}-shm`, "first cache");
      expect(retirementUnchanged(before, retirementState(database))).toBe(true);
      rmSync(`${database}-shm`);
      writeFileSync(`${database}-shm`, "different cache contents");
      expect(retirementUnchanged(before, retirementState(database))).toBe(true);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it.each(["wal", "checkpoint"])("ignores an empty reader cache but detects a same-count %s commit", mode => {
    const root = mkdtempSync(join(tmpdir(), "jarvis-retirement-cache-"));
    const database = join(root, "authority.sqlite");
    const source = new Database(database);
    try {
      source.pragma("journal_mode=WAL");
      source.exec("CREATE TABLE value_under_test(value); INSERT INTO value_under_test VALUES(1)");
      source.close();
      const before = retirementState(database);
      const probe = new Database(database, { readonly: true });
      try { probe.prepare("SELECT * FROM value_under_test").all(); } finally { probe.close(); }
      expect(retirementUnchanged(before, retirementState(database))).toBe(true);
      const writer = new Database(database);
      try {
        writer.pragma("wal_autocheckpoint=0");
        writer.exec("UPDATE value_under_test SET value=2");
        if (mode === "checkpoint") writer.pragma("wal_checkpoint(TRUNCATE)");
        expect(retirementUnchanged(before, retirementState(database))).toBe(false);
      } finally { writer.close(); }
      expect(retirementUnchanged(before, retirementState(database))).toBe(false);
    } finally { if (source.open) source.close(); rmSync(root, { recursive: true, force: true }); }
  });

  it("does not read an unreadable file as an unchanged one", () => {
    const root = mkdtempSync(join(tmpdir(), "jarvis-retirement-"));
    const database = join(root, "authority.sqlite");
    writeFileSync(database, "body");
    writeFileSync(`${database}-wal`, "log");
    const before = retirementState(database);
    expect(before.some(entry => entry.endsWith(":unreadable"))).toBe(false);

    // The directory stops answering, so the log's state cannot be read. It may have been written
    // into; nothing here can say it was not.
    chmodSync(root, 0o000);
    const after = retirementState(database);
    expect(after.some(entry => entry.endsWith(":unreadable"))).toBe(true);
    expect(retirementUnchanged(before, after)).toBe(false);
    expect(retirementUnchanged(after, after)).toBe(false);

    // Absence is still an answer, and an absent file that was absent before compares equal.
    chmodSync(root, 0o700);
    expect(retirementUnchanged(retirementState(database), retirementState(database))).toBe(true);
  });
});
