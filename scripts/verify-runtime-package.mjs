// Read-only integrity verification from the trusted development checkout.
import { createHash } from "node:crypto";
import { lstatSync, opendirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { BACKEND_OUTPUT_ROOTS, fileIdentity } from "./lib/backend-build-identity.mjs";
import { RUNTIME_PACKAGE_ROOTS } from "./lib/runtime-package-roots.mjs";
// Never import verification code from the candidate being checked.
import { runtimeDependencyIdentity } from "../dist/src/personal-os-release-manifest.js";

function requireValue(condition, code) { if (!condition) throw new Error(code); }
function boundedBytes(path) {
  const stat = lstatSync(path);
  requireValue(stat.isFile() && stat.size <= 8 * 1024 * 1024, "PACKAGE_METADATA_INVALID");
  const bytes = readFileSync(path);
  requireValue(bytes.length <= 8 * 1024 * 1024, "PACKAGE_METADATA_INVALID");
  return bytes;
}
function assertTree(path, budget, payload, depth = 0) {
  requireValue(depth <= 64 && --budget.entries >= 0, "PACKAGE_TREE_LIMIT");
  const stat = lstatSync(path);
  if (payload) requireValue(!stat.isSymbolicLink(), "PACKAGE_PAYLOAD_SYMLINK");
  requireValue(stat.isFile() || stat.isDirectory() || stat.isSymbolicLink(), "PACKAGE_TREE_INVALID");
  if (!stat.isDirectory()) {
    budget.bytes -= stat.size;
    requireValue(budget.bytes >= 0, "PACKAGE_TREE_LIMIT");
    return;
  }
  const directory = opendirSync(path);
  try {
    for (let entry; (entry = directory.readSync()) !== null;) {
      // fileIdentity intentionally skips these names; reject hidden executable dependencies.
      if (payload) requireValue(entry.name !== "node_modules" && entry.name !== ".git", "PACKAGE_UNTRACKED_PAYLOAD_TREE");
      assertTree(join(path, entry.name), budget, payload, depth + 1);
    }
  } finally {
    directory.closeSync();
  }
}
try {
  const { values, positionals } = parseArgs({ allowPositionals: true,
    options: { "receipt-sha256": { type: "string" } }, strict: true });
  requireValue(positionals.length === 1 && /^[0-9a-f]{64}$/.test(values["receipt-sha256"] ?? ""), "PACKAGE_USAGE");
  const root = resolve(positionals[0]);
  const bytes = boundedBytes(join(root, "runtime-package-receipt.json"));
  const receiptHash = createHash("sha256").update(bytes).digest("hex");
  requireValue(receiptHash === values["receipt-sha256"], "PACKAGE_RECEIPT_MISMATCH");
  const receipt = JSON.parse(bytes.toString("utf8"));
  requireValue(receipt.schema_version === 1 && receipt.kind === "isolated-authority-runtime-package"
    && receipt.deployment_ready === false, "PACKAGE_RECEIPT_INVALID");
  // Committed provenance is optional, but when present it must agree with the build identity it
  // was recorded beside; a release manifest is sealed from these fields.
  const provenance = receipt.release_source ?? null;
  if (provenance !== null) {
    requireValue(provenance.commit === receipt.source.head && provenance.tree === receipt.source.tree
      && /^[0-9a-f]{40}$/.test(provenance.tree ?? "") && /^[0-9a-f]{40}$/.test(provenance.first_parent ?? "")
      && /^[0-9a-f]{64}$/.test(provenance.archive_digest ?? "")
      && typeof provenance.subject === "string" && typeof provenance.commit_timestamp === "string"
      && Number.isSafeInteger(provenance.commit_epoch), "PACKAGE_RECEIPT_INVALID");
  }
  const payloadBudget = { entries: 32_768, bytes: 256 * 1024 * 1024 };
  for (const name of RUNTIME_PACKAGE_ROOTS) assertTree(join(root, name), payloadBudget, true);
  const payload = fileIdentity(root, RUNTIME_PACKAGE_ROOTS);
  requireValue(JSON.stringify(payload) === JSON.stringify(receipt.payload), "PACKAGE_PAYLOAD_MISMATCH");
  assertTree(join(root, "node_modules"), { entries: 65_536, bytes: 256 * 1024 * 1024 }, false);
  const dependencies = runtimeDependencyIdentity(join(root, "node_modules"));
  requireValue(JSON.stringify(dependencies) === JSON.stringify(receipt.dependencies), "PACKAGE_DEPENDENCIES_MISMATCH");
  const metadata = JSON.parse(boundedBytes(join(root, "dist/build-metadata.json")).toString("utf8"));
  requireValue(JSON.stringify(metadata.source) === JSON.stringify(receipt.source)
    && metadata.artifact.digest === fileIdentity(join(root, "dist"), BACKEND_OUTPUT_ROOTS).digest,
  "PACKAGE_BUILD_IDENTITY_MISMATCH");
  console.log(JSON.stringify({ ok: true, integrity: "matched", receipt_sha256: receiptHash,
    source_head: receipt.source.head, source_tree: receipt.source.tree ?? null,
    source_tracked_dirty: receipt.source.tracked_dirty ?? null,
    release_source: provenance, payload_files: payload.file_count, dependency_entries: dependencies.entry_count,
    signature_verified: false, runtime_validation: "not_performed", deployment_ready: false }));
} catch (error) {
  // Do not print candidate bytes, parse exceptions or filesystem paths in failures.
  const code = /^PACKAGE_[A-Z_]+$/.test(error.message) ? error.message : "PACKAGE_VERIFICATION_FAILED";
  console.error(JSON.stringify({ ok: false, code, deployment_ready: false }));
  process.exitCode = 1;
}
