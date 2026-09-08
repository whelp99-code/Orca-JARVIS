import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { secureRoot } from "../../src/secure-filesystem.js";

vi.mock("node:fs/promises", async importOriginal => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return { ...original, mkdir: vi.fn(original.mkdir) };
});
afterEach(() => { vi.mocked(mkdir).mockReset(); });

describe("secure root creation races", () => {
  it.each(["directory", "symlink", "file"])("rechecks a competing %s after EEXIST", async kind => {
    const original = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    vi.mocked(mkdir).mockImplementation(original.mkdir);
    const scratch = await mkdtemp(join(tmpdir(), "jarvis-secure-race-"));
    const root = join(scratch, "root"); const outside = join(scratch, "outside");
    try {
      await original.mkdir(outside, { mode: 0o755 });
      await writeFile(join(outside, "sentinel"), "unchanged");
      const mode = (await stat(outside)).mode;
      vi.mocked(mkdir).mockImplementationOnce(async () => {
        if (kind === "directory") await original.mkdir(root);
        else if (kind === "symlink") await symlink(outside, root);
        else await writeFile(root, "file");
        await original.mkdir(root);
        return undefined;
      });
      if (kind === "directory") {
        const result = await secureRoot(root);
        expect(result.path).toBe(root);
        expect((await stat(root)).mode & 0o777).toBe(0o700);
      } else await expect(secureRoot(root)).rejects.toThrow("APPROVED_PATH_SYMLINK");
      expect((await stat(outside)).mode).toBe(mode);
      expect(await readFile(join(outside, "sentinel"), "utf8")).toBe("unchanged");
    } finally { await rm(scratch, { recursive: true, force: true }); }
  });
});
