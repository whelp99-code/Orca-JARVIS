import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { openUnderSwapAdmission } from "./authority-database-swap-barrier.js";
import { JarvisError } from "./db.js";
import {
  MIGRATION_VECTOR_CANONICAL_REF,
  migrationVectorDigest,
} from "./personal-os-compatibility.js";
import { unavailable, type TypedUnavailable } from "./personal-os-rehearsal-contract.js";
import { activateCurrent, currentTarget, fileSha256, writeReleaseReceipt } from "./personal-os-rehearsal-release.js";
import { runReleaseRollback } from "./release-rollback.js";

export type RollbackBranch = {
  readonly kind: "allow" | "refuse";
  readonly switched: boolean;
  readonly current_before: string;
  readonly current_after: string;
  readonly unavailable: TypedUnavailable | null;
  readonly code: string | null;
};

function migrationEntries(dbPath: string): readonly { readonly id: string; readonly sha256: string }[] {
  const db = openUnderSwapAdmission(dbPath, () => new Database(dbPath, { readonly: true, fileMustExist: true }));
  try {
    return db.prepare("SELECT id, checksum AS sha256 FROM schema_migrations ORDER BY id").all() as Array<{
      readonly id: string;
      readonly sha256: string;
    }>;
  } finally {
    db.close();
  }
}

export function vectorDigest(input: {
  readonly head: string;
  readonly tree: string;
  readonly dbPath: string;
}): string {
  return migrationVectorDigest({
    canonical_ref: MIGRATION_VECTOR_CANONICAL_REF,
    head: input.head,
    tree: input.tree,
    migrations: migrationEntries(input.dbPath),
  });
}

function sealTarget(input: {
  readonly runtimeRoot: string;
  readonly sha: string;
  readonly head: string;
  readonly tree: string;
  readonly accepted: readonly string[];
  readonly providerDigest: string;
}): void {
  const release = join(input.runtimeRoot, "releases", input.sha);
  mkdirSync(release, { recursive: true });
  const manifest = {
    schema_version: 1,
    artifact: "jarvis-authority",
    source: {
      commit: input.head,
      tree: input.tree,
      first_parent: input.head,
      subject: "rehearsal-rollback-target",
      commit_timestamp: "2026-08-27T00:00:00.000Z",
      archive_digest: "a".repeat(64),
    },
    build: {
      source_date_epoch: 0,
      builder_command: "personal-os-rehearsal",
      offline_cache_digest: "e".repeat(64),
      lifecycle_command_digests: ["f".repeat(64)],
      reproducibility_receipt: "g".repeat(64),
    },
    entries: [],
    entry_count: 0,
    total_bytes: 0,
    payload_digest: "b".repeat(64),
    self_exclusion: { path: "release.manifest.json", count: 1 },
  };
  const bytes = `${JSON.stringify(manifest)}\n`;
  writeFileSync(join(release, "release.manifest.json"), bytes);
  writeReleaseReceipt({
    runtimeRoot: input.runtimeRoot,
    sha: input.sha,
    manifestSha256: fileSha256(join(release, "release.manifest.json")),
    payloadDigest: manifest.payload_digest,
    providerContractDigest: input.providerDigest,
    acceptedVectorDigests: input.accepted,
  });
}

export function rehearseRollbackBranch(input: {
  readonly runtimeRoot: string;
  readonly dbPath: string;
  readonly targetSha: string;
  readonly head: string;
  readonly tree: string;
  readonly providerDigest: string;
  readonly accept: boolean;
}): RollbackBranch {
  const before = currentTarget(input.runtimeRoot);
  if (before === undefined) throw new JarvisError("RELEASE_ROLLBACK_INCOMPATIBLE");
  const vector = vectorDigest({ head: input.head, tree: input.tree, dbPath: input.dbPath });
  const accepted = input.accept ? [vector] : ["c".repeat(64)];
  sealTarget({
    runtimeRoot: input.runtimeRoot,
    sha: input.targetSha,
    head: input.head,
    tree: input.tree,
    accepted,
    providerDigest: input.providerDigest,
  });
  if (!input.accept) {
    let code = "RELEASE_ROLLBACK_INCOMPATIBLE";
    try {
      runReleaseRollback({ to: input.targetSha, releaseRoot: input.runtimeRoot, dbPath: input.dbPath, dryRun: false });
      code = "RELEASE_ROLLBACK_UNEXPECTED_ALLOW";
    } catch (error) {
      if (!(error instanceof JarvisError)) throw error;
      code = error.code;
    }
    const after = currentTarget(input.runtimeRoot) ?? before;
    const refused = code === "RELEASE_ROLLBACK_INCOMPATIBLE" && after === before;
    return {
      kind: "refuse",
      switched: false,
      current_before: before,
      current_after: after,
      unavailable: refused ? unavailable("schema", code) : null,
      code,
    };
  }
  const result = runReleaseRollback({
    to: input.targetSha,
    releaseRoot: input.runtimeRoot,
    dbPath: input.dbPath,
    dryRun: false,
  });
  return {
    kind: "allow",
    switched: result.current_target === `releases/${input.targetSha}`,
    current_before: before,
    current_after: result.current_target,
    unavailable: null,
    code: null,
  };
}

export function restoreCurrent(runtimeRoot: string, sha: string): string {
  return activateCurrent(runtimeRoot, sha);
}

/** A provider pointer whose manifest digest is the value rollback will compare. */
export function pinProviderContract(runtimeRoot: string, digest: string): void {
  const sha = "d".repeat(40);
  const release = join(runtimeRoot, "provider-releases", "releases", sha);
  mkdirSync(release, { recursive: true });
  writeFileSync(join(release, "release.manifest.json"), `${JSON.stringify({ payload_digest: digest })}\n`);
  activateCurrent(join(runtimeRoot, "provider-releases"), sha);
}
