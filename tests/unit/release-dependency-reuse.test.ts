import { afterEach, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, copyFileSync, symlinkSync, existsSync, readlinkSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "release-dependencies-")); roots.push(root);
  const workspace = join(root, "workspace"), release = join(root, "release");
  mkdirSync(workspace); mkdirSync(release);
  const manifest = { name: "fixture", version: "1", dependencies: { "@modelcontextprotocol/sdk": "1.30.0" } };
  const lock = { lockfileVersion: 3, packages: { "": manifest, "node_modules/@modelcontextprotocol/sdk": { version: "1.30.0" } } };
  writeFileSync(join(workspace, "package.json"), JSON.stringify(manifest));
  const bytes = JSON.stringify(lock);
  for (const dir of [workspace, release]) writeFileSync(join(dir, "package-lock.json"), bytes);
  const installed = join(release, "node_modules/@modelcontextprotocol/sdk"); mkdirSync(installed, { recursive: true });
  writeFileSync(join(installed, "package.json"), JSON.stringify({ name: "@modelcontextprotocol/sdk", version: "1.30.0" }));
  const check = () => spawnSync(process.execPath, [resolve("scripts/check-release-dependency-reuse.mjs"), workspace, release], { encoding: "utf8" });
  return { workspace, release, installed, check };
}
it("permits matching locked dependencies and installed direct runtime versions", () => {
  const f = fixture(); const result = f.check(); expect(result.status).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, direct_runtime_dependencies: 1 });
});
it("rejects old lock before accepting reused modules", () => {
  const f = fixture(); writeFileSync(join(f.release, "package-lock.json"), "{}");
  expect(f.check().status).toBe(2); expect(f.check().stderr.trim()).toBe("RELEASE_DEPENDENCY_LOCK_MISMATCH");
});
it.each(["missing", "wrong-version"])("rejects %s installed runtime dependency", kind => {
  const f = fixture();
  if (kind === "missing") rmSync(f.installed, { recursive: true });
  else writeFileSync(join(f.installed, "package.json"), JSON.stringify({ version: "0.0.1" }));
  const result = f.check(); expect(result.status).toBe(2); expect(result.stderr.trim()).toBe("RELEASE_DEPENDENCY_TREE_MISMATCH");
});
it("rejects an unreflected package.json change even when lock files match", () => {
  const f = fixture(); writeFileSync(join(f.workspace, "package.json"), JSON.stringify({ dependencies: { other: "1" } }));
  const result = f.check(); expect(result.status).toBe(2); expect(result.stderr.trim()).toBe("RELEASE_DEPENDENCY_MANIFEST_MISMATCH");
});

it.each([
  ["authority", "before_build"], ["control-center", "before_build"],
  ["authority", "after_build"], ["control-center", "after_build"],
])("%s publisher rejects dependency changes %s and preserves current", (kind, phase) => {
  const f = fixture();
  const control = join(f.workspace, "control-runtime"), authority = join(f.workspace, "authority-runtime");
  mkdirSync(control); mkdirSync(authority); mkdirSync(join(control, "releases"));
  const dependency = join(control, "releases", "fixture");
  renameSync(f.release, dependency); symlinkSync("releases/fixture", join(control, "current"));
  const bin = join(f.workspace, "bin"), scripts = join(f.workspace, "scripts");
  mkdirSync(bin); mkdirSync(scripts);
  copyFileSync(resolve("scripts/check-release-dependency-reuse.mjs"), join(scripts, "check-release-dependency-reuse.mjs"));
  writeFileSync(join(control, "release-verifier.mjs"), "process.exit(0);\n");
  const marker = join(f.workspace, "build-called");
  writeFileSync(join(bin, "npm"), '#!/bin/sh\nprintf called > "$BUILD_MARKER"\nrm -- "$TEST_DEPENDENCY/package.json"\n', { mode: 0o700 });
  if (phase === "before_build") writeFileSync(join(dependency, "package-lock.json"), "{}");
  const before = readlinkSync(join(control, "current"));
  const result = spawnSync("bash", [resolve(`ops/${kind}/publish-verified-release.sh`), f.workspace], {
    encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, BUILD_MARKER: marker,
      TEST_DEPENDENCY: join(dependency, "node_modules/@modelcontextprotocol/sdk"),
      JARVIS_PRODUCTION_ACTIVATION_APPROVAL: "approved", JARVIS_NODE_BIN: process.execPath,
      JARVIS_AUTHORITY_RUNTIME_ROOT: authority, JARVIS_CONTROL_CENTER_RUNTIME_ROOT: control },
  });
  expect(result.status).toBe(2);
  expect(result.stderr.trim()).toBe(phase === "before_build" ? "RELEASE_DEPENDENCY_LOCK_MISMATCH" : "RELEASE_DEPENDENCY_TREE_MISMATCH");
  expect(existsSync(marker)).toBe(phase === "after_build");
  expect(readlinkSync(join(control, "current"))).toBe(before);
  expect(existsSync(join(authority, "current"))).toBe(false);
});
