#!/usr/bin/env node
import { lstatSync, mkdirSync, readdirSync, readlinkSync, rmSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";

const PRODUCTION_PROJECT = "/home/jm/orca/projects/Orca-JARVIS";
const PRODUCTION_SHM = "/dev/shm";
const SHM_NAME = /^(?:orca-jarvis(?:-|$)|jarvis-test-|jarvis-electron-real-|task30-real-process-|task33-|task36-)/u;

function fail(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

function parse(argv) {
  let values;
  try {
    ({ values } = parseArgs({
      args: [...argv],
      options: {
        production: { type: "boolean" },
        "fixture-root": { type: "string" },
        apply: { type: "boolean" },
      },
      strict: true,
    }));
  } catch {
    fail("TEST_ARTIFACT_CLEANUP_USAGE");
  }
  if (values.apply !== true) fail("TEST_ARTIFACT_CLEANUP_APPLY_REQUIRED");
  const fixture = values["fixture-root"];
  if ((values.production === true) === (fixture !== undefined)) fail("TEST_ARTIFACT_CLEANUP_MODE_INVALID");
  if (fixture === undefined) {
    return { project: PRODUCTION_PROJECT, shm: PRODUCTION_SHM, production: true };
  }
  const root = resolve(fixture);
  if (root === "/" || root === "/home" || root.startsWith("/home/jm/.local/state")
    || root.startsWith("/home/jm/.config")) fail("TEST_ARTIFACT_CLEANUP_FIXTURE_INVALID");
  return { project: join(root, "project"), shm: join(root, "shm"), production: false };
}

function inside(path, root) {
  return path === root || path.startsWith(`${root}${sep}`);
}

function inUse(target) {
  for (const name of readdirSync("/proc")) {
    if (!/^\d+$/u.test(name) || Number(name) === process.pid) continue;
    const processRoot = join("/proc", name);
    for (const link of [join(processRoot, "cwd"), join(processRoot, "root")]) {
      try {
        if (inside(resolve(readlinkSync(link)), target)) return true;
      } catch { /* process exited or permission denied */ }
    }
    let descriptors;
    try { descriptors = readdirSync(join(processRoot, "fd")); } catch { continue; }
    for (const descriptor of descriptors) {
      try {
        const linked = readlinkSync(join(processRoot, "fd", descriptor));
        if (linked.startsWith("/") && inside(resolve(linked.replace(/ \(deleted\)$/u, "")), target)) return true;
      } catch { /* descriptor changed */ }
    }
  }
  return false;
}

function byteSize(path) {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) return stat.size;
  let total = 0;
  for (const entry of readdirSync(path)) total += byteSize(join(path, entry));
  return total;
}

function removeGuarded(path, expectedParent, uid) {
  const target = resolve(path);
  if (resolve(expectedParent) !== resolve(join(target, ".."))) fail("TEST_ARTIFACT_CLEANUP_PATH_INVALID");
  const stat = lstatSync(target);
  if (stat.uid !== uid || stat.isSymbolicLink()) fail("TEST_ARTIFACT_CLEANUP_OWNER_INVALID");
  if (inUse(target)) fail("TEST_ARTIFACT_CLEANUP_IN_USE");
  const bytes = byteSize(target);
  rmSync(target, { recursive: true, force: false, maxRetries: 2, retryDelay: 20 });
  return bytes;
}

function cleanup(options) {
  const uid = process.getuid?.();
  if (uid === undefined) fail("TEST_ARTIFACT_CLEANUP_UID_REQUIRED");
  const project = resolve(options.project);
  const shm = resolve(options.shm);
  if (options.production && (project !== PRODUCTION_PROJECT || shm !== PRODUCTION_SHM)) {
    fail("TEST_ARTIFACT_CLEANUP_PRODUCTION_PATH_INVALID");
  }
  mkdirSync(project, { recursive: true });
  mkdirSync(shm, { recursive: true });
  const removed = [];
  let bytes = 0;
  const runtime = join(project, ".runtime-tmp");
  if (statSync(project).uid !== uid || lstatSync(project).isSymbolicLink()) {
    fail("TEST_ARTIFACT_CLEANUP_PROJECT_UNSAFE");
  }
  if (lstatExists(runtime)) {
    const runtimeStat = lstatSync(runtime);
    if (!runtimeStat.isDirectory() || runtimeStat.isSymbolicLink() || runtimeStat.uid !== uid) {
      fail("TEST_ARTIFACT_CLEANUP_RUNTIME_UNSAFE");
    }
    for (const name of readdirSync(runtime)) {
      const child = join(runtime, name);
      bytes += removeGuarded(child, runtime, uid);
      removed.push(child);
    }
  } else {
    mkdirSync(runtime, { mode: 0o700 });
  }
  for (const name of readdirSync(shm)) {
    if (!SHM_NAME.test(name)) continue;
    const child = join(shm, name);
    bytes += removeGuarded(child, shm, uid);
    removed.push(child);
  }
  return { removed_entries: removed.length, bytes_removed: bytes,
    gib_removed: Math.round((bytes / (1024 ** 3)) * 100) / 100 };
}

function lstatExists(path) {
  try { lstatSync(path); return true; } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

function main(argv) {
  const result = cleanup(parse(argv));
  process.stdout.write(`${JSON.stringify({ ok: true, ...result })}\n`);
}

const entry = process.argv[1];
if (entry !== undefined && resolve(entry) === resolve(fileURLToPath(import.meta.url))) {
  try { main(process.argv.slice(2)); } catch (error) {
    const code = error instanceof Error && "code" in error ? String(error.code) : "TEST_ARTIFACT_CLEANUP_FAILED";
    process.stderr.write(`${code}\n`);
    process.exit(2);
  }
}
