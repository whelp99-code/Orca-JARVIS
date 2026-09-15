// Seals a staged authority release: writes release-compatibility.json and release.manifest.json
// from provenance the package receipt already carried, using the product's own manifest library.
//
// Run from a trusted development checkout with its backend built. Nothing is imported from the
// candidate package: only its recorded bytes are read.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import Database from "better-sqlite3";

const HEX40 = /^[0-9a-f]{40}$/;

const { values } = parseArgs({
  options: {
    stage: { type: "string" },
    "sidecar-dir": { type: "string" },
    db: { type: "string" },
    commit: { type: "string" },
    tree: { type: "string" },
    "first-parent": { type: "string" },
    subject: { type: "string" },
    "commit-timestamp": { type: "string" },
    "commit-epoch": { type: "string" },
    "archive-digest": { type: "string" },
    "package-receipt-sha256": { type: "string" },
  },
  strict: true,
});

function required(name) {
  const value = values[name];
  if (value === undefined || value === "") throw new Error("RELEASE_SEAL_USAGE");
  return value;
}

const stage = resolve(required("stage"));
const commit = required("commit");
const tree = required("tree");
const firstParent = required("first-parent");
const pin = required("package-receipt-sha256");
if (!HEX40.test(commit) || !HEX40.test(tree) || !HEX40.test(firstParent)) throw new Error("RELEASE_SEAL_SOURCE_INVALID");

const library = await import(pathToFileURL(resolve("dist/src/personal-os-release-manifest.js")).href);
const compatibility = await import(pathToFileURL(resolve("dist/src/personal-os-compatibility.js")).href);

/** The applied migration vector of the database this release will migrate. */
function migrationVector(dbPath) {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const migrations = db.prepare("SELECT id, checksum AS sha256 FROM schema_migrations ORDER BY id").all();
    return compatibility.migrationVectorDigest({
      canonical_ref: compatibility.MIGRATION_VECTOR_CANONICAL_REF,
      head: commit,
      tree,
      migrations,
    });
  } finally {
    db.close();
  }
}

const sha256 = value => createHash("sha256").update(value).digest("hex");
const accepted = migrationVector(resolve(required("db")));

// Written before the manifest, so the manifest seals it along with the rest of the payload.
writeFileSync(join(stage, "release-compatibility.json"),
  `${JSON.stringify({ schema_version: 1, accepted_vector_digests: [accepted] })}\n`);

const written = library.writeReleaseManifest({
  root: stage,
  sidecarDir: resolve(required("sidecar-dir")),
  artifact: "jarvis-authority",
  source: {
    commit,
    tree,
    first_parent: firstParent,
    subject: required("subject"),
    commit_timestamp: required("commit-timestamp"),
    archive_digest: required("archive-digest"),
  },
  build: {
    source_date_epoch: Number(required("commit-epoch")),
    builder_command: "ops/authority/publish-package-release.sh",
    offline_cache_digest: sha256(readFileSync(join(stage, "package-lock.json"))),
    lifecycle_command_digests: ["scripts/package-authority-runtime.mjs", "scripts/verify-runtime-package.mjs"]
      .map(name => sha256(readFileSync(resolve(name)))),
    // What this publish can actually attest: the committed archive bound to the verified package.
    reproducibility_receipt: sha256(`orca-jarvis/package-release-reproducibility/v1\0${required("archive-digest")}\0${pin}`),
  },
});

const manifestBytes = readFileSync(join(stage, "release.manifest.json"));
const sidecar = JSON.parse(readFileSync(written.sidecarPath, "utf8"));
const manifestSha = sha256(manifestBytes);
if (sidecar.manifest_sha256 !== manifestSha || sidecar.payload_digest !== written.manifest.payload_digest) {
  throw new Error("RELEASE_SEAL_SIDECAR_MISMATCH");
}

process.stdout.write(`${JSON.stringify({
  ok: true,
  payload_digest: written.manifest.payload_digest,
  manifest_sha256: manifestSha,
  accepted_vector_digest: accepted,
  entry_count: written.manifest.entry_count,
  sidecar: written.sidecarPath,
})}\n`);
