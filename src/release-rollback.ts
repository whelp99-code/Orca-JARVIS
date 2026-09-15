import { createHash } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { openUnderSwapAdmission } from "./authority-database-swap-barrier.js";
import { JarvisError } from "./db.js";
import {
  MIGRATION_VECTOR_CANONICAL_REF,
  decideRollback,
  migrationVectorDigest,
  type MigrationEntry,
} from "./personal-os-compatibility.js";
import { MANIFEST_NAME } from "./personal-os-release-manifest.js";
import { assertIsolatedRoot } from "./personal-os-protected-paths.js";

const HEX40 = /^[0-9a-f]{40}$/;
/** The same owner gate the publish `--activate` requires; rollback is the same production act. */
export const PRODUCTION_ACTIVATION_APPROVAL_ENV = "JARVIS_PRODUCTION_ACTIVATION_APPROVAL" as const;
const HEX64 = /^[0-9a-f]{64}$/;
export const RELEASE_COMPATIBILITY_NAME = "release-compatibility.json" as const;

/** Every refusal is the documented one: the caller learns nothing about which input disagreed. */
const incompatible = (): never => { throw new JarvisError("RELEASE_ROLLBACK_INCOMPATIBLE"); };

export type RollbackDecisionFacts = {
  readonly current_release: string;
  readonly target_release: string;
  readonly expected_vector_digest: string;
  readonly target_accepted_digests: readonly string[];
  readonly provider_contract_match: boolean;
  readonly sealed_manifest_match: boolean;
};

export type RollbackResult = {
  readonly schema_version: 1;
  readonly rollback: "allow";
  readonly dry_run: boolean;
  readonly current_target: string;
  readonly facts: RollbackDecisionFacts;
};

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return incompatible();
  return value as Record<string, unknown>;
}

function readJson(path: string): Record<string, unknown> {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.size > 8 * 1024 * 1024) return incompatible();
    return record(JSON.parse(readFileSync(path, "utf8")));
  } catch (error) {
    if (error instanceof JarvisError) throw error;
    return incompatible();
  }
}

function fileDigest(path: string): string {
  try {
    return createHash("sha256").update(readFileSync(path)).digest("hex");
  } catch {
    return incompatible();
  }
}

function hex64(value: unknown): string {
  return typeof value === "string" && HEX64.test(value) ? value : incompatible();
}

/** `current` is a relative symlink into `releases/`; an absolute or foreign target is not a release. */
function activeRelease(releaseRoot: string): string {
  let target: string;
  try {
    target = readlinkSync(join(releaseRoot, "current"));
  } catch {
    return incompatible();
  }
  const sha = target.startsWith("releases/") ? target.slice("releases/".length) : undefined;
  return sha !== undefined && HEX40.test(sha) ? sha : incompatible();
}

function releaseDirectory(releaseRoot: string, sha: string): string {
  const path = join(releaseRoot, "releases", sha);
  try {
    if (!lstatSync(path).isDirectory()) return incompatible();
  } catch {
    return incompatible();
  }
  return path;
}

function acceptedVectorDigests(releaseDir: string): readonly string[] {
  const compatibility = readJson(join(releaseDir, RELEASE_COMPATIBILITY_NAME));
  if (compatibility["schema_version"] !== 1) return incompatible();
  const accepted = compatibility["accepted_vector_digests"];
  if (!Array.isArray(accepted) || accepted.length === 0) return incompatible();
  return accepted.map(value => hex64(value));
}

function migrationEntries(dbPath: string): readonly MigrationEntry[] {
  try {
    const db = openUnderSwapAdmission(dbPath,
      () => new Database(dbPath, { readonly: true, fileMustExist: true }));
    try {
      return db.prepare("SELECT id, checksum AS sha256 FROM schema_migrations ORDER BY id")
        .all() as MigrationEntry[];
    } finally {
      db.close();
    }
  } catch {
    return incompatible();
  }
}

/**
 * The migration vector the target release expects: its own sealed source identity bound to the
 * migrations applied to the database right now. Binding the target's identity rather than the
 * running release's is what makes this an *exact* check — the target accepted exactly this vector
 * when it was published, so it matches only while the database is still at that schema. A vector
 * bound to the running release instead could never match a target published before it existed.
 */
function expectedVectorDigest(targetDir: string, dbPath: string): string {
  const manifest = readJson(join(targetDir, MANIFEST_NAME));
  const source = record(manifest["source"]);
  const head = source["commit"];
  const tree = source["tree"];
  if (typeof head !== "string" || !HEX40.test(head) || typeof tree !== "string" || !HEX40.test(tree)) {
    return incompatible();
  }
  return migrationVectorDigest({
    canonical_ref: MIGRATION_VECTOR_CANONICAL_REF,
    head,
    tree,
    migrations: migrationEntries(dbPath),
  });
}

/**
 * The target's sealed manifest still hashes to what its receipt pinned, payload included. A
 * receipt that was never written, or a manifest edited after sealing, is not a match.
 */
function sealedManifestMatch(releaseRoot: string, sha: string, releaseDir: string): boolean {
  const receipt = readJson(join(releaseRoot, "receipts", `${sha}.json`));
  const manifest = readJson(join(releaseDir, MANIFEST_NAME));
  return hex64(receipt["manifest_sha256"]) === fileDigest(join(releaseDir, MANIFEST_NAME))
    && hex64(receipt["payload_digest"]) === hex64(manifest["payload_digest"]);
}

/** The provider contract the target was sealed against is the one currently published. */
function providerContractMatch(releaseRoot: string, sha: string): boolean {
  const receipt = readJson(join(releaseRoot, "receipts", `${sha}.json`));
  const expected = hex64(receipt["provider_contract_digest"]);
  let providerTarget: string;
  try {
    providerTarget = readlinkSync(join(releaseRoot, "provider-releases", "current"));
  } catch {
    return incompatible();
  }
  const manifest = readJson(join(releaseRoot, "provider-releases", providerTarget, MANIFEST_NAME));
  return expected === hex64(manifest["payload_digest"]);
}

function fsyncDir(path: string): void {
  const fd = openSync(path, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** Activation is a relative-current-symlink replaced by an atomic rename. */
function activate(releaseRoot: string, sha: string): string {
  const currentTarget = `releases/${sha}`;
  const temporary = join(releaseRoot, `.current-rollback-${sha}-${process.pid}`);
  rmSync(temporary, { force: true });
  symlinkSync(currentTarget, temporary);
  fsyncDir(releaseRoot);
  renameSync(temporary, join(releaseRoot, "current"));
  fsyncDir(releaseRoot);
  return currentTarget;
}

export type RollbackInput = {
  readonly releaseRoot: string;
  readonly dbPath: string;
  readonly to: string;
  readonly dryRun: boolean;
  /** Rollback is a production command: the protected authority root is allowed only on request. */
  readonly productionRoot?: boolean;
  readonly ownerApproval?: string;
};

/**
 * An isolated root needs nothing. The deployed authority root is reachable only when the caller
 * asked for it by name and carries the owner production-activation-gate evidence, and that is
 * decided before anything is read, so a refusal touches no deployed state at all.
 */
export function rollbackReleaseRoot(input: {
  readonly releaseRoot: string;
  readonly productionRoot?: boolean;
  readonly ownerApproval?: string;
}): string {
  if (input.productionRoot !== true) return assertIsolatedRoot(input.releaseRoot);
  const approval = input.ownerApproval ?? process.env[PRODUCTION_ACTIVATION_APPROVAL_ENV];
  if (approval !== "approved") throw new JarvisError("JARVIS_PRODUCTION_ACTIVATION_APPROVAL_REQUIRED");
  return resolve(input.releaseRoot);
}

/**
 * Rollback is allowed only when exact-migration-vector, provider-contract and sealed-manifest all
 * match the target release. Otherwise this refuses with RELEASE_ROLLBACK_INCOMPATIBLE and leaves
 * `current` exactly where it was: the refusal path performs no filesystem mutation at all.
 *
 * The release root must be isolated unless `productionRoot` was asked for with the owner gate.
 */
export function runReleaseRollback(input: RollbackInput): RollbackResult {
  if (!HEX40.test(input.to)) throw new JarvisError("RELEASE_ROLLBACK_INPUT_INVALID");
  const releaseRoot = rollbackReleaseRoot(input);
  const current = activeRelease(releaseRoot);
  // `current` must itself be a published release; a pointer into nothing is not a state to roll
  // back from, even though the vector compared below is the target's.
  releaseDirectory(releaseRoot, current);
  const targetDir = releaseDirectory(releaseRoot, input.to);
  const facts: RollbackDecisionFacts = {
    current_release: current,
    target_release: input.to,
    expected_vector_digest: expectedVectorDigest(targetDir, input.dbPath),
    target_accepted_digests: acceptedVectorDigests(targetDir),
    provider_contract_match: providerContractMatch(releaseRoot, input.to),
    sealed_manifest_match: sealedManifestMatch(releaseRoot, input.to, targetDir),
  };
  const decision = decideRollback({
    currentVectorDigest: facts.expected_vector_digest,
    targetAcceptedDigests: facts.target_accepted_digests,
    providerContractMatch: facts.provider_contract_match,
    sealedManifestMatch: facts.sealed_manifest_match,
  });
  if (decision.kind !== "allow") throw new JarvisError(decision.code);
  return {
    schema_version: 1,
    rollback: "allow",
    dry_run: input.dryRun,
    current_target: input.dryRun ? `releases/${current}` : activate(releaseRoot, input.to),
    facts,
  };
}
