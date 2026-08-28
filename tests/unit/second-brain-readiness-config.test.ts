import { execFileSync } from "node:child_process";
import { constants, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { open, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import * as readinessRuntime from "../../src/second-brain-readiness-runtime.js";

const VALID = 'vault_root = "/safe/vault"\n';

type ConfigurationProbe = (path: string, opener?: unknown) => Promise<unknown>;

function configurationProbe(): ConfigurationProbe {
  const value = Reflect.get(readinessRuntime, "probeSecondBrainConfiguration");
  if (typeof value !== "function") throw new TypeError("probeSecondBrainConfiguration export required");
  return (path, opener) => Reflect.apply(value, undefined, opener === undefined ? [path] : [path, opener]);
}

describe("pinned Second Brain configuration descriptor", () => {
  it("rejects symlink, FIFO, device, directory, empty, oversize, and malformed paths without blocking", async () => {
    const root = mkdtempSync(join(tmpdir(), "second-brain-config-boundary-"));
    try {
      const valid = join(root, "valid.toml");
      const link = join(root, "link.toml");
      const fifo = join(root, "config.fifo");
      const directory = join(root, "directory");
      writeFileSync(valid, VALID);
      symlinkSync(valid, link);
      execFileSync("mkdir", [directory]);
      execFileSync("mkfifo", [fifo]);
      writeFileSync(join(root, "empty.toml"), "");
      writeFileSync(join(root, "oversize.toml"), "x".repeat(65_537));
      writeFileSync(join(root, "malformed.toml"), "not_config=true\n");
      writeFileSync(join(root, "invalid-utf8.toml"), Buffer.from([0xff, 0xfe]));
      const probe = configurationProbe();
      await expect(probe(valid)).resolves.toBe("valid");
      await expect(probe(link)).resolves.toBe("malformed");
      await expect(probe(fifo)).resolves.toBe("malformed");
      await expect(probe("/dev/null")).resolves.toBe("malformed");
      await expect(probe(directory)).resolves.toBe("malformed");
      await expect(probe(join(root, "empty.toml"))).resolves.toBe("malformed");
      await expect(probe(join(root, "oversize.toml"))).resolves.toBe("malformed");
      await expect(probe(join(root, "malformed.toml"))).resolves.toBe("malformed");
      await expect(probe(join(root, "invalid-utf8.toml"))).resolves.toBe("malformed");
      await expect(probe(join(root, "missing.toml"))).resolves.toBe("missing");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reads pinned bytes after replacement and closes the descriptor exactly once", async () => {
    const root = mkdtempSync(join(tmpdir(), "second-brain-config-race-"));
    try {
      const path = join(root, "config.toml");
      const replacement = join(root, "replacement.toml");
      writeFileSync(path, VALID);
      writeFileSync(replacement, "malformed=true\n");
      let opens = 0;
      let closes = 0;
      let flags = 0;
      const opener = {
        open: async (openedPath: string, openedFlags: number) => {
          opens += 1;
          flags = openedFlags;
          const handle = await open(openedPath, openedFlags);
          await rename(replacement, path);
          return {
            stat: () => handle.stat(),
            read: (buffer: Uint8Array, offset: number, length: number, position: number) => {
              return handle.read(buffer, offset, length, position);
            },
            close: async () => {
              closes += 1;
              await handle.close();
            },
          };
        },
      };
      await expect(configurationProbe()(path, opener)).resolves.toBe("valid");
      expect({ opens, closes, flags }).toEqual({
        opens: 1,
        closes: 1,
        flags: constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("maps open, fstat, read, and close failures to fixed unavailable and closes opened descriptors", async () => {
    const probe = configurationProbe();
    const openFailure = { open: async () => { throw new Error("credential=/secret/path"); } };
    await expect(probe("/not/exposed", openFailure)).resolves.toBe("unavailable");
    for (const failure of ["fstat", "read", "close"]) {
      let closes = 0;
      const opener = {
        open: async () => ({
          stat: async () => {
            if (failure === "fstat") throw new Error("fstat raw");
            return { size: VALID.length, isFile: () => true };
          },
          read: async (buffer: Uint8Array) => {
            if (failure === "read") throw new Error("read raw");
            buffer.set(Buffer.from(VALID));
            return { bytesRead: VALID.length };
          },
          close: async () => {
            closes += 1;
            if (failure === "close") throw new Error("close raw");
          },
        }),
      };
      await expect(probe("/not/exposed", opener)).resolves.toBe("unavailable");
      expect(closes).toBe(1);
    }
  });
});
