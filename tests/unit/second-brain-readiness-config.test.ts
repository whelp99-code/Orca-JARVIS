import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { constants, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { open, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import * as readinessRuntime from "../../src/second-brain-readiness-runtime.js";

const VALID = 'vault_root = "/safe/vault"\n';

type CorpusCase = {
  readonly name: string;
  readonly text: string;
  readonly accepted: boolean;
  readonly vault?: string;
};

const CORPUS: readonly CorpusCase[] = [
  { name: "basic", text: 'vault_root="/safe/vault"\n', accepted: true, vault: "/safe/vault" },
  { name: "whitespace-comment", text: ' # lead\n\tvault_root = "/safe/vault" # tail\n', accepted: true, vault: "/safe/vault" },
  { name: "literal", text: "vault_root='/safe/#=vault'\n", accepted: true, vault: "/safe/#=vault" },
  { name: "escaped", text: 'vault_root="/safe/\\u03bb\\troot"\n', accepted: true, vault: "/safe/λ\troot" },
  { name: "unicode", text: 'vault_root="/안전/보관"\n', accepted: true, vault: "/안전/보관" },
  { name: "basic-symbols", text: 'vault_root="/safe/#=vault"#comment\n', accepted: true, vault: "/safe/#=vault" },
  {
    name: "full-producer-config",
    text: 'vault_root="/safe/full"\n[caps]\nmax_llm_calls_compile=20\n[llm]\nargv_template=["claude","-p","{prompt}"]\nprompt_version="v1"\nmodel_id="model\\u002d1"\n[unified_db]\ndsn="postgresql://localhost/db"\n[[sources]]\nid="inbox"\ntype="filesystem"\npath="/safe/inbox"\n[search]\nmodes=["lexical","semantic"]\n',
    accepted: true,
    vault: "/safe/full",
  },
  {
    name: "full-comments-multiline",
    text: 'vault_root="/safe/multiline" # explicit\n[connector]\nenabled=true\npatterns=["*.md","*.txt"]\ndescription="""line one\nline two"""\n',
    accepted: true,
    vault: "/safe/multiline",
  },
  { name: "duplicate", text: 'vault_root="/a"\nvault_root="/b"\n', accepted: false },
  { name: "unknown-key", text: 'vault_root="/a"\ninvalid=true\n', accepted: true, vault: "/a" },
  { name: "malformed-tail", text: 'vault_root="/a"\ninvalid=[\n', accepted: false },
  { name: "section", text: '[main]\nvault_root="/a"\n', accepted: false },
  { name: "dotted", text: 'root.vault_root="/a"\n', accepted: false },
  { name: "boolean", text: 'vault_root=true\n', accepted: false },
  { name: "number", text: 'vault_root=1\n', accepted: false },
  { name: "array", text: 'vault_root=["/a"]\n', accepted: false },
  { name: "bad-escape", text: 'vault_root="/a\\q"\n', accepted: false },
  { name: "bad-unicode-escape", text: 'vault_root="/a\\u0xx0"\n', accepted: false },
  { name: "surrogate-escape", text: 'vault_root="/a\\uD800"\n', accepted: false },
  { name: "unclosed", text: 'vault_root="/a\n', accepted: false },
  { name: "multiline-basic", text: 'vault_root="""/a"""\n', accepted: true, vault: "/a" },
  { name: "multiline-literal", text: "vault_root='''/a'''\n", accepted: true, vault: "/a" },
  { name: "trailing-junk", text: 'vault_root="/a" junk\n', accepted: false },
  { name: "control", text: 'vault_root="/a\u0001"\n', accepted: false },
  { name: "comment-control", text: 'vault_root="/a" # bad\u0001\n', accepted: false },
  { name: "empty", text: 'vault_root=""\n', accepted: false },
];

type ConfigurationProbe = (path: string, opener?: unknown, parser?: unknown) => Promise<unknown>;

function configurationProbe(): ConfigurationProbe {
  const value = Reflect.get(readinessRuntime, "probeSecondBrainConfiguration");
  if (typeof value !== "function") throw new TypeError("probeSecondBrainConfiguration export required");
  return (path, opener, parser) => Reflect.apply(
    value,
    undefined,
    parser === undefined ? opener === undefined ? [path] : [path, opener] : [path, opener, parser],
  );
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

  it("parses complete TOML against the repository-owned provider configuration corpus", async () => {
    const root = mkdtempSync(join(tmpdir(), "second-brain-config-corpus-"));
    try {
      for (const [index, item] of CORPUS.entries()) {
        const path = join(root, `${String(index)}.toml`);
        writeFileSync(path, item.text);
        const outcome = await configurationProbe()(path);
        expect(outcome, item.name).toBe(item.accepted ? "valid" : "malformed");
      }
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
      let parserCalls = 0;
      let parserHash = "";
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
      const parser = async (bytes: Uint8Array) => {
        parserCalls += 1;
        parserHash = createHash("sha256").update(bytes).digest("hex");
        return "valid";
      };
      await expect(configurationProbe()(path, opener, parser)).resolves.toBe("valid");
      expect({ opens, closes, flags, parserCalls, parserHash }).toEqual({
        opens: 1,
        closes: 1,
        flags: constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
        parserCalls: 1,
        parserHash: createHash("sha256").update(VALID).digest("hex"),
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
