import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { privateRunRoot, removeNewProviderChildren } from "../../scripts/lib/provider-storage-cleanup.mjs";

describe("provider storage cleanup", () => {
  it("removes only children created after the file started", () => {
    const root = mkdtempSync(join(tmpdir(), "run-"));
    try {
      mkdirSync(join(root, "kept"));
      writeFileSync(join(root, "kept", "marker"), "stay");
      const seen = new Set(["kept"]);
      mkdirSync(join(root, "jarvis-test-new"));
      writeFileSync(join(root, "loose.tmp"), "gone");
      expect(removeNewProviderChildren(root, seen).sort()).toEqual(["jarvis-test-new", "loose.tmp"]);
      expect(removeNewProviderChildren(root, seen)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not treat a shared temporary directory as a private run", () => {
    expect(privateRunRoot({ TMPDIR: "/tmp" })).toBeUndefined();
    expect(privateRunRoot({ TMPDIR: "/tmp/jarvis-provider-XXXX" })).toBeUndefined();
    expect(privateRunRoot({ TMPDIR: "/tmp/run-abc" })).toBe("/tmp/run-abc");
  });
});
