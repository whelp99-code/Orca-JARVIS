import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { retirementState, retirementUnchanged } from "../../src/local-observation-retention-publish.js";

describe("retirement evidence", () => {
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
