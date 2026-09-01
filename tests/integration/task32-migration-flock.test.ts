import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openPrivateSpoolRoot, readPrivateSpoolFile, writePrivateSpoolFile,
  type PrivateSpoolRoot } from "../../src/memory-private-spool-files.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function spoolRoot(): PrivateSpoolRoot {
  const path = mkdtempSync(join(tmpdir(), "task32-private-spool-"));
  roots.push(path);
  return openPrivateSpoolRoot(path);
}

describe("Task 32 private publication file safety", () => {
  it("publishes owner-only bytes readable through the guarded reader", () => {
    // Given a validated private spool root
    const root = spoolRoot();
    const target = join(root.path, "publication.json");
    // When a publication is written
    const created = writePrivateSpoolFile(root, target, Buffer.from("{\"a\":1}"), "pub");
    // Then it lands owner-only and round-trips through the guarded reader
    expect(created).toBe(true);
    expect((statSync(target).mode & 0o077)).toBe(0);
    expect(readPrivateSpoolFile(root, target).toString("utf8")).toBe("{\"a\":1}");
  });

  it("reports a same-path republish as not-created instead of clobbering bytes", () => {
    // Given an existing publication
    const root = spoolRoot();
    const target = join(root.path, "publication.json");
    writePrivateSpoolFile(root, target, Buffer.from("original"), "pub");
    const before = statSync(target).ino;
    // When a second publication targets the same path
    const created = writePrivateSpoolFile(root, target, Buffer.from("replacement"), "pub");
    // Then the original inode and bytes survive
    expect(created).toBe(false);
    expect(statSync(target).ino).toBe(before);
    expect(readFileSync(target, "utf8")).toBe("original");
  });

  it("refuses to read a publication path that is a symlink", () => {
    // Given a symlink planted where a publication is expected
    const root = spoolRoot();
    const outside = join(root.path, "outside.json");
    writeFileSync(outside, "attacker", { mode: 0o600 });
    const target = join(root.path, "publication.json");
    symlinkSync(outside, target);
    // When the guarded reader opens it
    const read = (): Buffer => readPrivateSpoolFile(root, target);
    // Then the no-follow open refuses rather than reading through the link
    expect(read).toThrow();
  });

  it("rejects a root whose mode became group or world accessible", () => {
    // Given a validated root
    const root = spoolRoot();
    // When its mode is widened underneath the process
    chmodSync(root.path, 0o755);
    const write = (): boolean => writePrivateSpoolFile(root, join(root.path, "p.json"),
      Buffer.from("x"), "pub");
    // Then publication fails closed
    expect(write).toThrow("MEMORY_SPOOL_ROOT_CHANGED");
  });
});
