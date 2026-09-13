import { createHash } from "node:crypto";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { authorityFileContent } from "../../src/authority-file-content.js";

it("refuses a hardlink created during a scan but accepts a stable linked source", () => {
  const root = fs.mkdtempSync(join(tmpdir(), "authority-content-link-"));
  const source = join(root, "source");
  const retired = join(root, "retired");
  const bytes = Buffer.alloc(128 * 1024, 1);
  const read = fs.readSync;
  const spy = vi.spyOn(fs, "readSync").mockImplementationOnce((...args) => {
    fs.linkSync(source, retired);
    return Reflect.apply(read, fs, args);
  });
  syncBuiltinESMExports();
  try {
    fs.writeFileSync(source, bytes);
    const before = fs.statSync(source, { bigint: true });
    expect(() => authorityFileContent(source, before)).toThrow("AUTHORITY_FILE_CHANGED_DURING_READ");
    spy.mockRestore();
    syncBuiltinESMExports();
    const after = fs.statSync(retired, { bigint: true });
    expect(after.nlink).toBe(2n);
    expect(authorityFileContent(retired, after)).toBe(createHash("sha256").update(bytes).digest("hex"));
  } finally { spy.mockRestore(); syncBuiltinESMExports(); fs.rmSync(root, { recursive: true, force: true }); }
});
