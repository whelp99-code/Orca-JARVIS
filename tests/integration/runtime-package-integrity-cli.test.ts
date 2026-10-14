import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";
import { runtimeDependencyIdentity } from "../../src/personal-os-release-manifest.js";

async function fixture() {
  const identity = await import(pathToFileURL(resolve("scripts/lib/backend-build-identity.mjs")).href);
  const { RUNTIME_PACKAGE_ROOTS: roots } = await import(pathToFileURL(resolve("scripts/lib/runtime-package-roots.mjs")).href);
  const root = mkdtempSync(join(tmpdir(), "jarvis-package-integrity-"));
  for (const name of ["dist/src", "dist/tests", "dist/migrations", "dist/contracts", "dist/dashboard", "migrations", "config", "scripts", "node_modules"]) {
    mkdirSync(join(root, name), { recursive: true });
    writeFileSync(join(root, name, "fixture.txt"), "fixture\n");
  }
  // The verifier must hash this candidate module, never import it.
  writeFileSync(join(root, "dist/src/personal-os-release-manifest.js"), "throw new Error('CANDIDATE_CODE_EXECUTED');\n");
  for (const name of [
    "package.json",
    "package-lock.json",
    "scripts/cli-smoke.mjs",
    "scripts/owner-key-enrollment.mjs",
    "scripts/export-messenger-summary.mjs",
  ]) writeFileSync(join(root, name), "{}\n");
  const source = { head: "a".repeat(40), fixture: true };
  const artifact = identity.fileIdentity(join(root, "dist"), identity.BACKEND_OUTPUT_ROOTS);
  writeFileSync(join(root, "dist/build-metadata.json"), JSON.stringify({ source, artifact }));
  const receipt = JSON.stringify({ schema_version: 1, kind: "isolated-authority-runtime-package", source,
    payload: identity.fileIdentity(root, roots), dependencies: runtimeDependencyIdentity(join(root, "node_modules")), deployment_ready: false });
  writeFileSync(join(root, "runtime-package-receipt.json"), receipt);
  const pin = createHash("sha256").update(receipt).digest("hex");
  return { root, pin };
}

function verify(root: string, pin: string) {
  const result = spawnSync(process.execPath, ["scripts/verify-runtime-package.mjs", root, "--receipt-sha256", pin],
    { encoding: "utf8", timeout: 10_000 });
  expect(result.error).toBeUndefined();
  expect(result.signal).toBeNull();
  return { code: result.status, body: JSON.parse(result.stdout || result.stderr) };
}

it("checks pinned package bytes without executing candidate code or claiming activation", async () => {
  const { root, pin } = await fixture();
  try {
    const before = readFileSync(join(root, "runtime-package-receipt.json"));
    expect(verify(root, pin)).toMatchObject({ code: 0, body: { integrity: "matched", signature_verified: false,
      runtime_validation: "not_performed", deployment_ready: false } });
    expect(readFileSync(join(root, "runtime-package-receipt.json"))).toEqual(before);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it.each([
  ["pin", "PACKAGE_RECEIPT_MISMATCH"],
  ["payload", "PACKAGE_PAYLOAD_MISMATCH"],
  ["dependency", "PACKAGE_DEPENDENCIES_MISMATCH"],
  ["nested", "PACKAGE_UNTRACKED_PAYLOAD_TREE"],
  ["missing", "PACKAGE_VERIFICATION_FAILED"],
  ["owner-cli", "PACKAGE_VERIFICATION_FAILED"],
  ["messenger-export", "PACKAGE_VERIFICATION_FAILED"],
] as const)("rejects %s changes through the real CLI", async (kind, code) => {
  const { root, pin } = await fixture();
  try {
    if (kind === "payload") writeFileSync(join(root, "config/fixture.txt"), "changed\n");
    if (kind === "dependency") writeFileSync(join(root, "node_modules/additional.txt"), "extra\n");
    if (kind === "nested") mkdirSync(join(root, "dist/src/node_modules"));
    if (kind === "missing") rmSync(join(root, "scripts/cli-smoke.mjs"));
    if (kind === "owner-cli") rmSync(join(root, "scripts/owner-key-enrollment.mjs"));
    if (kind === "messenger-export") rmSync(join(root, "scripts/export-messenger-summary.mjs"));
    expect(verify(root, kind === "pin" ? "0".repeat(64) : pin)).toMatchObject({ code: 1,
      body: { ok: false, code, deployment_ready: false } });
  } finally { rmSync(root, { recursive: true, force: true }); }
});
