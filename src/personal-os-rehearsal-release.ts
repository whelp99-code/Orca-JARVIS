import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync,
  readlinkSync, renameSync, rmSync, symlinkSync, writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { PersonalOsError } from "./personal-os-errors.js";
import { assertIsolatedRoot } from "./personal-os-protected-paths.js";
import { writeReleaseManifest, type ReleaseManifest, type ReleaseSource } from "./personal-os-release-manifest.js";

const STUB_CLI = "export {};";
const ROOTS = ["dist", "migrations", "config", "package.json", "package-lock.json", "contracts"] as const;

export type PlacedRelease = {
  readonly sha: string;
  readonly release: string;
  readonly manifest: ReleaseManifest;
  readonly manifestSha256: string;
  readonly source: ReleaseSource;
};

function fsyncDir(path: string): void {
  const fd = openSync(path, "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

function git(sourceRoot: string, args: readonly string[]): string | undefined {
  const result = spawnSync("git", ["-C", sourceRoot, ...args], { encoding: "utf8" });
  if (result.status !== 0) return undefined;
  const text = result.stdout.trim();
  return text.length > 0 ? text : undefined;
}

function sourceIdentity(sourceRoot: string, payloadDigest: string): { readonly sha: string; readonly source: ReleaseSource } {
  const head = git(sourceRoot, ["rev-parse", "HEAD"]);
  const tree = git(sourceRoot, ["rev-parse", "HEAD^{tree}"]);
  const parent = git(sourceRoot, ["rev-parse", "HEAD^"]) ?? head;
  const subject = git(sourceRoot, ["log", "-1", "--format=%s"]) ?? "personal-os-rehearsal";
  const timestamp = git(sourceRoot, ["log", "-1", "--format=%cI"]) ?? "2026-08-27T00:00:00Z";
  const dirty = git(sourceRoot, ["status", "--porcelain"]);
  const clean = head !== undefined && tree !== undefined && parent !== undefined && (dirty === undefined || dirty.length === 0);
  const sha = clean && head !== undefined ? head : payloadDigest.slice(0, 40);
  return {
    sha,
    source: {
      commit: head ?? sha,
      tree: tree ?? payloadDigest.slice(0, 40),
      first_parent: parent ?? sha,
      subject,
      commit_timestamp: timestamp,
      archive_digest: payloadDigest,
    },
  };
}

export function assembleRehearsalRelease(input: {
  readonly stage: string;
  readonly sourceRoot: string;
  readonly sidecarDir: string;
}): PlacedRelease {
  const stage = assertIsolatedRoot(input.stage);
  const cli = join(input.sourceRoot, "dist/src/cli.js");
  if (!existsSync(cli)) throw new PersonalOsError("E_REHEARSAL_GATE");
  const text = readFileSync(cli, "utf8");
  if (text.trim() === STUB_CLI || !text.includes("execute")) throw new PersonalOsError("E_REHEARSAL_GATE");
  mkdirSync(stage, { recursive: true });
  for (const name of ROOTS) {
    const from = join(input.sourceRoot, name);
    if (!existsSync(from)) continue;
    const copied = spawnSync("cp", ["-aL", from, join(stage, name)], { encoding: "utf8" });
    if (copied.status !== 0) throw new PersonalOsError("E_REHEARSAL_GATE");
  }
  const modules = join(input.sourceRoot, "node_modules");
  if (!existsSync(modules)) throw new PersonalOsError("E_REHEARSAL_GATE");
  const linked = spawnSync("cp", ["-aL", modules, join(stage, "node_modules")], { encoding: "utf8" });
  if (linked.status !== 0) throw new PersonalOsError("E_REHEARSAL_GATE");
  const identity = sourceIdentity(input.sourceRoot, "0".repeat(64));
  const written = writeReleaseManifest({
    root: stage,
    artifact: "jarvis-authority",
    source: identity.source,
    build: {
      source_date_epoch: 0,
      builder_command: "personal-os-rehearsal",
      offline_cache_digest: "e".repeat(64),
      lifecycle_command_digests: ["f".repeat(64)],
      reproducibility_receipt: identity.sha === identity.source.commit ? "g".repeat(64) : "d".repeat(64),
    },
    sidecarDir: input.sidecarDir,
  });
  const digest = written.manifest.payload_digest;
  const sealed = sourceIdentity(input.sourceRoot, digest);
  if (sealed.sha !== identity.sha || sealed.source.commit !== identity.source.commit) {
    writeReleaseManifest({
      root: stage,
      artifact: "jarvis-authority",
      source: { ...sealed.source, archive_digest: digest },
      build: {
        source_date_epoch: 0,
        builder_command: "personal-os-rehearsal",
        offline_cache_digest: "e".repeat(64),
        lifecycle_command_digests: ["f".repeat(64)],
        reproducibility_receipt: sealed.sha === sealed.source.commit ? "g".repeat(64) : "d".repeat(64),
      },
      sidecarDir: input.sidecarDir,
    });
  }
  const manifestPath = join(stage, "release.manifest.json");
  const manifestSha256 = createHash("sha256").update(readFileSync(manifestPath)).digest("hex");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as ReleaseManifest;
  return {
    sha: sealed.sha,
    release: stage,
    manifest,
    manifestSha256,
    source: { ...sealed.source, archive_digest: manifest.payload_digest },
  };
}

export function placeRelease(input: {
  readonly stage: string;
  readonly runtimeRoot: string;
  readonly sha: string;
}): { readonly release: string } {
  const runtimeRoot = assertIsolatedRoot(input.runtimeRoot);
  mkdirSync(join(runtimeRoot, "releases"), { recursive: true });
  const release = join(runtimeRoot, "releases", input.sha);
  if (existsSync(release)) throw new PersonalOsError("E_RELEASE_MISMATCH");
  renameSync(input.stage, release);
  fsyncDir(join(runtimeRoot, "releases"));
  return { release };
}

export function activateCurrent(runtimeRoot: string, sha: string): string {
  const root = assertIsolatedRoot(runtimeRoot);
  const currentTarget = `releases/${sha}`;
  const temporary = join(root, `.current-${sha}`);
  rmSync(temporary, { force: true });
  symlinkSync(currentTarget, temporary);
  fsyncDir(root);
  renameSync(temporary, join(root, "current"));
  fsyncDir(root);
  return currentTarget;
}

export function currentTarget(runtimeRoot: string): string | undefined {
  try { return readlinkSync(join(runtimeRoot, "current")); } catch { return undefined; }
}

export function writeReleaseReceipt(input: {
  readonly runtimeRoot: string;
  readonly sha: string;
  readonly manifestSha256: string;
  readonly payloadDigest: string;
  readonly providerContractDigest: string;
  readonly acceptedVectorDigests: readonly string[];
}): void {
  const root = assertIsolatedRoot(input.runtimeRoot);
  const release = join(root, "releases", input.sha);
  writeFileSync(join(release, "release-compatibility.json"), `${JSON.stringify({
    schema_version: 1,
    accepted_vector_digests: input.acceptedVectorDigests,
    provider_contract_digest: input.providerContractDigest,
  })}\n`);
  mkdirSync(join(root, "receipts"), { recursive: true });
  writeFileSync(join(root, "receipts", `${input.sha}.json`), `${JSON.stringify({
    schema_version: 1,
    manifest_sha256: input.manifestSha256,
    payload_digest: input.payloadDigest,
    provider_contract_digest: input.providerContractDigest,
  })}\n`);
}

export function fileSha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function assertRegularRelease(path: string): void {
  if (!lstatSync(path).isDirectory()) throw new PersonalOsError("E_STAGE_INVALID");
}
