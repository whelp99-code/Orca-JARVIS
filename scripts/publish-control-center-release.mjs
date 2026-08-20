#!/usr/bin/env node
import { createHash } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

const REQUIRED = [
  "package.json",
  "package-lock.json",
  "dist/src/dashboard/server.js",
  "dist/src/dashboard/main.js",
  "dist/dashboard/index.html",
];
const SHA = /^[0-9a-f]{40}$/;

function fail(code) {
  process.stderr.write(`${code}\n`);
  process.exit(2);
}

function existing(path) {
  try {
    return lstatSync(path);
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code === "ENOENT") return undefined;
    throw error;
  }
}

function isFile(path) {
  return existing(path)?.isFile() === true;
}

function isDirectory(path) {
  return existing(path)?.isDirectory() === true;
}

function fingerprint(root) {
  /** @type {Map<string, string>} */
  const files = new Map();
  const walk = (dir, rel) => {
    for (const name of readdirSync(dir).sort()) {
      const nextRel = rel ? `${rel}/${name}` : name;
      const nextPath = join(dir, name);
      const stat = lstatSync(nextPath);
      if (stat.isDirectory()) {
        walk(nextPath, nextRel);
        continue;
      }
      if (!stat.isFile()) fail("E_STAGE_INVALID");
      files.set(nextRel, createHash("sha256").update(readFileSync(nextPath)).digest("hex"));
    }
  };
  walk(root, "");
  return files;
}

function sameFingerprint(left, right) {
  if (left.size !== right.size) return false;
  for (const [key, value] of left) {
    if (right.get(key) !== value) return false;
  }
  return true;
}

function publishCurrent(runtimeRoot, sha) {
  const current = join(runtimeRoot, "current");
  const temporary = join(runtimeRoot, `.current-${sha}`);
  rmSync(temporary, { force: true });
  try {
    const stat = existing(current);
    if (stat && !stat.isSymbolicLink()) fail("E_CURRENT_NOT_SYMLINK");
    symlinkSync(join("releases", sha), temporary);
    renameSync(temporary, current);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

let values;
try {
  ({ values } = parseArgs({
    options: {
      stage: { type: "string" },
      "runtime-root": { type: "string" },
      sha: { type: "string" },
    },
    strict: true,
  }));
} catch {
  fail("E_USAGE");
}

if (!values.stage || !values["runtime-root"] || !values.sha) fail("E_USAGE");
if (!SHA.test(values.sha)) fail("E_SHA_INVALID");

const stage = resolve(values.stage);
const runtimeRoot = resolve(values["runtime-root"]);
const sha = values.sha;
if (!isDirectory(stage) || REQUIRED.some((rel) => !isFile(join(stage, rel)))) fail("E_STAGE_INVALID");

const releaseDir = join(runtimeRoot, "releases", sha);
const present = existing(releaseDir);
if (present) {
  if (!present.isDirectory() || !sameFingerprint(fingerprint(stage), fingerprint(releaseDir))) {
    fail("E_RELEASE_MISMATCH");
  }
} else {
  mkdirSync(join(runtimeRoot, "releases"), { recursive: true });
  renameSync(stage, releaseDir);
}

try {
  publishCurrent(runtimeRoot, sha);
} catch (error) {
  rmSync(join(runtimeRoot, `.current-${sha}`), { force: true });
  throw error;
}

process.stdout.write(`{"ok":true,"sha":"${sha}","current":"releases/${sha}"}\n`);
