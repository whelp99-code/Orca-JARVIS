import { chmodSync, closeSync, fsyncSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";

function unsupported(reason, info) {
  const error = new Error("TEST_PROVIDER_STORAGE_UNSUPPORTED");
  error.reason = reason;
  error.metadata = {
    is_directory: info.isDirectory(), is_symlink: info.isSymbolicLink(),
    uid_matches: info.uid === globalThis.process.getuid(), nlink: info.nlink, mode: info.mode & 0o777,
  };
  return error;
}

function storageReason(info, requireNlink = false) {
  if (info.isSymbolicLink()) return "symlink";
  if (!info.isDirectory()) return "not_directory";
  if (info.uid !== globalThis.process.getuid()) return "owner_mismatch";
  if (requireNlink && info.nlink < 2) return "nlink_below_2";
  return undefined;
}

function ioCode(error) {
  return error && typeof error === "object" && "code" in error && error.code ? String(error.code) : "IO";
}

export function providerStorageBase(env = process.env) {
  const selector = env.JARVIS_TEST_PROVIDER_STORAGE_ROOT;
  if (selector === undefined) return tmpdir();
  if (typeof selector !== "string" || selector.trim() === "" || !isAbsolute(selector)) {
    throw new Error("TEST_PROVIDER_STORAGE_SELECTOR_INVALID");
  }
  let info;
  try { info = lstatSync(selector); }
  catch (error) { throw new Error("TEST_TMPDIR_UNAVAILABLE", { cause: ioCode(error) }); }
  const reason = storageReason(info, true);
  if (reason) throw unsupported(reason, info);
  return realpathSync(selector);
}

export function createTestEnvironment(env = process.env) {
  const base = env.TMPDIR || tmpdir();
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
  const child = { ...env, TMPDIR: root, TMP: root, TEMP: root };
  // An unset provider root used to resolve to the host Second Brain and spend about 6s per lookup.
  // Leave this path uncreated so a test that did not name a provider fails closed instead.
  if (!child.JARVIS_PROVIDER_STATE_ROOT?.trim()) {
    child.JARVIS_PROVIDER_STATE_ROOT = join(root, "absent-second-brain-state");
  }
  return { root, env: child, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}
