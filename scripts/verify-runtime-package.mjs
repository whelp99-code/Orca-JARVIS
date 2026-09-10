// Read-only integrity verification from the trusted development checkout.
import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync } from "node:fs";
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
function assertPayloadTree(path) {
  const stat = lstatSync(path);
  requireValue(!stat.isSymbolicLink(), "PACKAGE_PAYLOAD_SYMLINK");
  if (!stat.isDirectory()) return;
  for (const name of readdirSync(path)) {
    // fileIdentity intentionally skips these names; reject hidden executable dependencies.
    requireValue(name !== "node_modules" && name !== ".git", "PACKAGE_UNTRACKED_PAYLOAD_TREE");
    assertPayloadTree(join(path, name));
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
  for (const name of RUNTIME_PACKAGE_ROOTS) assertPayloadTree(join(root, name));
  const payload = fileIdentity(root, RUNTIME_PACKAGE_ROOTS);
  requireValue(JSON.stringify(payload) === JSON.stringify(receipt.payload), "PACKAGE_PAYLOAD_MISMATCH");
  const dependencies = runtimeDependencyIdentity(join(root, "node_modules"));
  requireValue(JSON.stringify(dependencies) === JSON.stringify(receipt.dependencies), "PACKAGE_DEPENDENCIES_MISMATCH");
  const metadata = JSON.parse(boundedBytes(join(root, "dist/build-metadata.json")).toString("utf8"));
  requireValue(JSON.stringify(metadata.source) === JSON.stringify(receipt.source)
    && metadata.artifact.digest === fileIdentity(join(root, "dist"), BACKEND_OUTPUT_ROOTS).digest,
  "PACKAGE_BUILD_IDENTITY_MISMATCH");
  console.log(JSON.stringify({ ok: true, integrity: "matched", receipt_sha256: receiptHash,
    source_head: receipt.source.head, payload_files: payload.file_count, dependency_entries: dependencies.entry_count,
    signature_verified: false, runtime_validation: "not_performed", deployment_ready: false }));
} catch (error) {
  // Do not print candidate bytes, parse exceptions or filesystem paths in failures.
  const code = /^PACKAGE_[A-Z_]+$/.test(error.message) ? error.message : "PACKAGE_VERIFICATION_FAILED";
  console.error(JSON.stringify({ ok: false, code, deployment_ready: false }));
  process.exitCode = 1;
}
