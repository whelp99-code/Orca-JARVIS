import { chmodSync, closeSync, fsyncSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

export function createTestEnvironment(env = process.env) {
  const base = env.TMPDIR || join(homedir(), ".cache", "orca-jarvis", "tests");
  let root;
  try {
    if (!isAbsolute(base)) throw new Error("absolute path required");
    if (env.TMPDIR) {
      if (!statSync(base).isDirectory()) throw new Error("directory required");
    } else mkdirSync(base, { recursive: true });
    root = mkdtempSync(join(base, "run-")); chmodSync(root, 0o700);
    const probe = join(root, "write-probe");
    const expected = Buffer.alloc(4096, 0x5a);
    writeFileSync(probe, expected, { mode: 0o600 });
    const fd = openSync(probe, "r+");
    try { fsyncSync(fd); } finally { closeSync(fd); }
    if (!readFileSync(probe).equals(expected)) throw new Error("readback mismatch");
    rmSync(probe);
  } catch (error) {
    if (root) rmSync(root, { recursive: true, force: true });
    throw new Error("TEST_TMPDIR_UNAVAILABLE", { cause: error });
  }
  return { root, env: { ...env, TMPDIR: root, TMP: root, TEMP: root },
    cleanup: () => rmSync(root, { recursive: true, force: true }) };
}
