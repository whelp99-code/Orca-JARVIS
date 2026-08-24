#!/usr/bin/env node
import { createHash } from "node:crypto";
import { closeSync, constants, mkdirSync, openSync, readFileSync, readSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const REFUSALS = Object.freeze({
  ARTIFACT_MISSING: "THIRD_PARTY_ARTIFACT_MISSING",
  DELEGATION_MISSING: "THIRD_PARTY_DELEGATION_MISSING",
  SIGNER_MISMATCH: "THIRD_PARTY_SIGNER_MISMATCH",
  GRANT_EXPIRED: "THIRD_PARTY_GRANT_EXPIRED",
  COMMIT_MISMATCH: "THIRD_PARTY_COMMIT_MISMATCH",
  PATH_NOT_COVERED: "THIRD_PARTY_PATH_NOT_COVERED",
  ACTION_NOT_GRANTED: "THIRD_PARTY_ACTION_NOT_GRANTED",
  PERMISSION_INVALID: "THIRD_PARTY_PERMISSION_INVALID",
});

const RIGHTS_HOLDER = "BeyondWorks/Yoogeon Kim";
const PRIVATE_KEYS = ["signature", "contact", "email", "phone", "private_key", "contents"];
const ACTIONS = new Set(["copy", "modify", "derive", "internal_use", "redistribute", "host_for_third_parties"]);

export function sha256Bytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function sha256File(path) {
  return sha256Bytes(readFileSync(path));
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

function matchPath(pattern, relativePath) {
  if (pattern === relativePath) return true;
  if (pattern.endsWith("/**")) {
    const prefix = pattern.slice(0, -3);
    return relativePath === prefix || relativePath.startsWith(`${prefix}/`);
  }
  return false;
}

export function assertPermissionShape(permission) {
  if (!isRecord(permission) || permission.schema_version !== 1) fail(REFUSALS.PERMISSION_INVALID);
  for (const key of PRIVATE_KEYS) {
    if (key in permission) fail(REFUSALS.PERMISSION_INVALID);
  }
  if (typeof permission.artifact_sha256 !== "string" || !/^[a-f0-9]{64}$/.test(permission.artifact_sha256)) fail(REFUSALS.PERMISSION_INVALID);
  if (typeof permission.issuer !== "string" || permission.issuer.length === 0) fail(REFUSALS.PERMISSION_INVALID);
  if (typeof permission.signer !== "string" || permission.signer.length === 0) fail(REFUSALS.PERMISSION_INVALID);
  if (!Array.isArray(permission.delegation_chain)) fail(REFUSALS.PERMISSION_INVALID);
  if (!isRecord(permission.covered) || typeof permission.covered.repository !== "string" || typeof permission.covered.commit !== "string") fail(REFUSALS.PERMISSION_INVALID);
  if (!Array.isArray(permission.covered.path_patterns) || permission.covered.path_patterns.length === 0) fail(REFUSALS.PERMISSION_INVALID);
  if (!Array.isArray(permission.allowed_actions) || permission.allowed_actions.some(action => !ACTIONS.has(action))) fail(REFUSALS.PERMISSION_INVALID);
  if (typeof permission.expires_at !== "string" || Number.isNaN(Date.parse(permission.expires_at))) fail(REFUSALS.PERMISSION_INVALID);
}

export function assertSignerAuthority(permission) {
  const chain = permission.delegation_chain.map(String);
  if (permission.signer.includes("Kim Hyo-yul") && permission.issuer !== RIGHTS_HOLDER && !chain.includes(RIGHTS_HOLDER)) {
    fail(REFUSALS.DELEGATION_MISSING);
  }
  const fromRightsHolder = permission.issuer === RIGHTS_HOLDER || permission.signer === RIGHTS_HOLDER || chain.includes(RIGHTS_HOLDER);
  if (!fromRightsHolder) fail(REFUSALS.SIGNER_MISMATCH);
}

export function verifyPermission(permission, options = {}) {
  assertPermissionShape(permission);
  const artifactPath = options.artifactPath;
  if (typeof artifactPath !== "string" || artifactPath.length === 0) fail(REFUSALS.ARTIFACT_MISSING);
  let artifactHash;
  try {
    artifactHash = sha256File(artifactPath);
  } catch {
    fail(REFUSALS.ARTIFACT_MISSING);
  }
  if (artifactHash !== permission.artifact_sha256) fail(REFUSALS.ARTIFACT_MISSING);
  assertSignerAuthority(permission);
  if (Date.parse(permission.expires_at) <= Date.parse(options.now ?? new Date().toISOString())) fail(REFUSALS.GRANT_EXPIRED);
  const lock = options.lock;
  if (isRecord(lock) && isRecord(lock.sources) && isRecord(lock.sources.argo)) {
    if (lock.sources.argo.commit !== permission.covered.commit) fail(REFUSALS.COMMIT_MISMATCH);
  }
  if (typeof options.commit === "string" && options.commit !== permission.covered.commit) fail(REFUSALS.COMMIT_MISMATCH);
  if (typeof options.relativePath === "string") {
    const covered = permission.covered.path_patterns.some(pattern => matchPath(String(pattern), options.relativePath));
    if (!covered) fail(REFUSALS.PATH_NOT_COVERED);
  }
  if (typeof options.action === "string" && !permission.allowed_actions.includes(options.action)) fail(REFUSALS.ACTION_NOT_GRANTED);
  return { ok: true, artifact_sha256: artifactHash };
}

function openNoFollow(path, flags) {
  return openSync(path, flags | constants.O_NOFOLLOW);
}

function readNoFollow(path) {
  const fd = openNoFollow(path, constants.O_RDONLY);
  try {
    const chunks = [];
    const buffer = Buffer.alloc(64 * 1024);
    for (;;) {
      const n = readSync(fd, buffer, 0, buffer.length, null);
      if (n === 0) break;
      chunks.push(Buffer.from(buffer.subarray(0, n)));
    }
    return Buffer.concat(chunks);
  } finally {
    closeSync(fd);
  }
}

export function importAuthorizedSource(input) {
  const permission = input.permission;
  const relativePath = input.relativePath;
  verifyPermission(permission, {
    artifactPath: input.artifactPath,
    lock: input.lock,
    commit: input.commit,
    relativePath,
    action: input.action ?? "copy",
    now: input.now,
  });
  const sourceRoot = resolve(input.sourceRoot);
  const sourcePath = resolve(sourceRoot, relativePath);
  const rel = relative(sourceRoot, sourcePath);
  if (rel.startsWith(`..${sep}`) || rel === "..") fail(REFUSALS.PATH_NOT_COVERED);
  const sourceBytes = readNoFollow(sourcePath);
  const destination = resolve(input.destinationPath);
  mkdirSync(dirname(destination), { recursive: true });
  const tempPath = `${destination}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tempPath, sourceBytes);
  const destHash = sha256Bytes(sourceBytes);
  const row = {
    origin: "copied",
    source_path: rel.split(sep).join("/"),
    source_sha256: destHash,
    destination_sha256: destHash,
    transform: "verbatim-copy",
    notice: permission.attribution,
    grant_commit: permission.covered.commit,
    grant_action: input.action ?? "copy",
    imported_at: input.now ?? new Date().toISOString(),
  };
  const provenancePath = resolve(input.provenancePath);
  mkdirSync(dirname(provenancePath), { recursive: true });
  writeFileSync(provenancePath, `${readFileSync(existsOrEmpty(provenancePath), "utf8")}${JSON.stringify(row)}\n`);
  renameSync(tempPath, destination);
  return row;
}

function existsOrEmpty(path) {
  try {
    readFileSync(path);
    return path;
  } catch {
    writeFileSync(path, "");
    return path;
  }
}

export function independentProvenance(relativePath) {
  return { origin: "independent", source_path: relativePath, source_sha256: null };
}

function repoRoot() {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..");
}

export function loadJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const root = repoRoot();
    const permission = loadJson(process.env.JARVIS_ARGO_PERMISSION_JSON ?? join(root, "third_party/argo/PERMISSION.json"));
    const lock = loadJson(join(root, "third_party/sources.lock.json"));
    const artifact = process.env.JARVIS_ARGO_PERMISSION_PATH;
    const result = verifyPermission(permission, { artifactPath: artifact, lock });
    process.stdout.write(`${JSON.stringify({ ok: true, ...result })}\n`);
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : REFUSALS.PERMISSION_INVALID;
    process.stderr.write(`${JSON.stringify({ ok: false, error: { code } })}\n`);
    process.exitCode = 2;
  }
}
