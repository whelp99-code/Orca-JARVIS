import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync, lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { join, relative, resolve } from "node:path";

export const BACKEND_OUTPUT_ROOTS = ["src", "tests", "migrations", "contracts"];
const INPUT_ROOTS = ["src", "tests", "dashboard", "migrations", "contracts", "config", "scripts",
  "package.json", "package-lock.json", "tsconfig.json", "tsconfig.dashboard.json", "tsconfig.e2e.json", ".node-version"];
const MAX_FILES = 16_384;
const MAX_BYTES = 256 * 1024 * 1024;
export const buildDigest = value => `sha256:${createHash("sha256").update(value).digest("hex")}`;

/** Only paths and digests leave this function; input contents are never written to the manifest. */
export function fileIdentity(root, roots) {
  const entries = [];
  let total = 0;
  function walk(path) {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) throw new Error("BACKEND_BUILD_SYMLINK");
    if (stat.isDirectory()) {
      for (const name of readdirSync(path).sort()) {
        if (name !== "node_modules" && name !== ".git") walk(join(path, name));
      }
      return;
    }
    if (!stat.isFile() || entries.length >= MAX_FILES || stat.size > MAX_BYTES - total) {
      throw new Error("BACKEND_BUILD_INPUT_LIMIT");
    }
    const bytes = readFileSync(path);
    total += bytes.length;
    if (total > MAX_BYTES) throw new Error("BACKEND_BUILD_INPUT_LIMIT");
    entries.push({ path: relative(root, path).split("\\").join("/"), bytes: bytes.length,
      mode: stat.mode & 0o777, sha256: buildDigest(bytes) });
  }
  for (const name of roots) {
    const path = join(root, name);
    try { lstatSync(path); }
    catch (error) { if (error.code === "ENOENT") continue; throw error; }
    walk(path);
  }
  entries.sort((left, right) => Buffer.compare(Buffer.from(left.path), Buffer.from(right.path)));
  return { entries, file_count: entries.length, total_bytes: total,
    digest: buildDigest(`orca-jarvis/backend-file-vector/v1\0${JSON.stringify(entries)}`) };
}

export function backendSourceIdentity(root) {
  const files = fileIdentity(root, INPUT_ROOTS);
  const git = args => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  let head = null;
  let dirty = null;
  try {
    if (realpathSync(git(["rev-parse", "--show-toplevel"])) === realpathSync(root)) {
      const candidate = git(["rev-parse", "HEAD"]);
      if (/^[0-9a-f]{40}$/.test(candidate)) head = candidate;
      dirty = git(["status", "--porcelain", "--untracked-files=all"]).length !== 0;
    }
  } catch { /* Source archives and installations without Git retain null identity fields. */ }
  const compiler = JSON.parse(readFileSync(resolve(root, "node_modules/typescript/package.json"), "utf8")).version;
  return { head, dirty, input_digest: files.digest, input_file_count: files.file_count,
    toolchain: { node: process.version, modules: process.versions.modules, platform: process.platform,
      arch: process.arch, typescript: compiler } };
}

/** Seal only generated staging files, then identify their final on-disk modes. */
export function sealBackendArtifacts(root) {
  const before = fileIdentity(root, BACKEND_OUTPUT_ROOTS);
  for (const entry of before.entries) {
    const mode = entry.mode & ~0o022;
    if (mode !== entry.mode) chmodSync(join(root, entry.path), mode);
  }
  return fileIdentity(root, BACKEND_OUTPUT_ROOTS);
}
