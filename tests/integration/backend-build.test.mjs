import { execFileSync, spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { BACKEND_OUTPUT_ROOTS, fileIdentity } from "../../scripts/lib/backend-build-identity.mjs";

const roots = [];
const contractFiles = ["second-brain-mcp-v1", "second-brain-mcp-v3", "second-brain-mcp-v4",
  "second-brain-mcp-v5", "second-brain-scoped-read-v1", "second-brain-scoped-read-v2"]
  .flatMap(name => [`${name}.json`, `${name}.json.sha256`]);
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "jarvis-backend-build-")); roots.push(root);
  for (const name of ["src", "contracts", "config", "migrations", "scripts/lib", "dist/src", "dist/dashboard"]) {
    mkdirSync(join(root, name), { recursive: true });
  }
  symlinkSync(resolve("node_modules"), join(root, "node_modules"), "dir");
  for (const file of ["scripts/build-backend.mjs", "scripts/lib/backend-build-identity.mjs", "scripts/copy-migrations.mjs"]) {
    cpSync(file, join(root, file));
  }
  writeFileSync(join(root, "package.json"), JSON.stringify({ type: "module" }));
  writeFileSync(join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: {
    module: "NodeNext", target: "ES2022", rootDir: ".", strict: true, types: [], skipLibCheck: true,
  }, include: ["src/**/*"] }));
  writeFileSync(join(root, "src/index.ts"), "export const answer: number = 42;\n");
  writeFileSync(join(root, "config/personal-os-policy.json"), '{"fixture":"policy"}\n');
  writeFileSync(join(root, "src/entry.mts"), "export const marker = 'esm';\n");
  writeFileSync(join(root, "migrations/001_fixture.sql"), "CREATE TABLE fixture(value TEXT);\n");
  for (const name of contractFiles) cpSync(join("contracts", name), join(root, "contracts", name));
  writeFileSync(join(root, "dist/src/orphan.js"), "old output\n");
  writeFileSync(join(root, "dist/dashboard/index.html"), "independent dashboard\n");
  writeFileSync(join(root, "dist/build-metadata.json"), "old metadata\n");
  writeFileSync(join(root, ".gitignore"), "node_modules/\ndist/\n");
  return root;
}
function build(root) {
  return spawnSync(process.execPath, [join(root, "scripts/build-backend.mjs")], { cwd: root, encoding: "utf8", timeout: 20_000 });
}
const manifest = root => JSON.parse(readFileSync(join(root, "dist/build-metadata.json"), "utf8"));
function successful(root) {
  const result = build(root);
  expect({ status: result.status, error: result.error?.message, stderr: result.stderr }).toEqual({ status: 0, error: undefined, stderr: "" });
  expect(readdirSync(join(root, "dist")).filter(name => name.startsWith(".backend-stage-"))).toEqual([]);
  return manifest(root);
}

describe("backend build publication", () => {
  it("publishes runnable JS/MJS and exact contract/migration vectors while removing obsolete output", () => {
    const root = fixture(); const metadata = successful(root);
    expect(metadata).toMatchObject({ schema_version: 1, kind: "jarvis-backend-build",
      source: { head: null, dirty: null, toolchain: { node: process.version } },
      migrations: [{ id: "001_fixture.sql" }] });
    expect(metadata.artifact).toEqual(fileIdentity(join(root, "dist"), BACKEND_OUTPUT_ROOTS));
    expect(readdirSync(join(root, "dist/contracts")).sort()).toEqual([...contractFiles].sort());
    for (const name of contractFiles) {
      expect(readFileSync(join(root, "dist/contracts", name))).toEqual(readFileSync(join(root, "contracts", name)));
    }
    expect(metadata.artifact.entries.map(item => item.path)).toEqual(expect.arrayContaining([
      "src/index.js", "src/entry.mjs", "contracts/second-brain-mcp-v3.json", "migrations/001_fixture.sql",
      "src/personal-os-policy.json",
    ]));
    expect(readFileSync(join(root, "dist/src/personal-os-policy.json"), "utf8"))
      .toBe(readFileSync(join(root, "config/personal-os-policy.json"), "utf8"));
    expect(existsSync(join(root, "dist/src/orphan.js"))).toBe(false);
    expect(readFileSync(join(root, "dist/dashboard/index.html"), "utf8")).toBe("independent dashboard\n");
    expect(execFileSync(process.execPath, ["--input-type=module", "-e",
      "import {answer} from './dist/src/index.js'; import {marker} from './dist/src/entry.mjs'; console.log(answer,marker)"],
    { cwd: root, encoding: "utf8" }).trim()).toBe("42 esm");
    const oldDigest = metadata.artifact.digest;
    writeFileSync(join(root, "dist/src/entry.mjs"), "export const marker = 'changed';\n");
    expect(fileIdentity(join(root, "dist"), BACKEND_OUTPUT_ROOTS).digest).not.toBe(oldDigest);
  }, 25_000);

  it("removes compiled files when their source disappears on the next build", () => {
    const root = fixture(); successful(root);
    rmSync(join(root, "src/entry.mts")); const metadata = successful(root);
    expect(existsSync(join(root, "dist/src/entry.mjs"))).toBe(false);
    expect(metadata.artifact.entries.some(item => item.path === "src/entry.mjs")).toBe(false);
  }, 25_000);

  it("leaves previous code intact and invalidates metadata on compiler failure", () => {
    const root = fixture(); writeFileSync(join(root, "src/index.ts"), "export const answer: number = 'invalid';\n");
    const result = build(root);
    expect(result.status).toBe(1); expect(result.stderr).toContain("BACKEND_BUILD_COMMAND_FAILED");
    expect(readFileSync(join(root, "dist/src/orphan.js"), "utf8")).toBe("old output\n");
    expect(existsSync(join(root, "dist/build-metadata.json"))).toBe(false);
    expect(readdirSync(join(root, "dist")).filter(name => name.startsWith(".backend-stage-"))).toEqual([]);
  }, 25_000);

  it("rejects input changes made after compilation and before publication", () => {
    const root = fixture();
    const copier = join(root, "scripts/copy-migrations.mjs");
    writeFileSync(copier, readFileSync(copier, "utf8")
      + "\n(await import('node:fs')).appendFileSync('src/index.ts', '\\nexport const changed = true;\\n');\n");
    const result = build(root);
    expect(result.status).toBe(1); expect(result.stderr).toContain("BACKEND_BUILD_SOURCE_CHANGED");
    expect(readFileSync(join(root, "dist/src/orphan.js"), "utf8")).toBe("old output\n");
    expect(existsSync(join(root, "dist/build-metadata.json"))).toBe(false);
  }, 25_000);

  it("preserves dirty source identity separately from its unchanged Git commit", () => {
    const root = fixture();
    const git = args => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    git(["init"]); git(["add", "."]);
    git(["-c", "user.name=Build fixture", "-c", "user.email=build@example.invalid", "-c", "commit.gpgsign=false", "commit", "-m", "fixture"]);
    const first = successful(root); expect(first.source.head).toBe(git(["rev-parse", "HEAD"])); expect(first.source.dirty).toBe(false);
    writeFileSync(join(root, "src/index.ts"), "export const answer: number = 43;\n");
    const second = successful(root); expect(second.source.head).toBe(first.source.head); expect(second.source.dirty).toBe(true);
    expect(second.source.input_digest).not.toBe(first.source.input_digest);
    expect(second.artifact.digest).not.toBe(first.artifact.digest);
  }, 25_000);

  it("rejects a competing builder before touching the current manifest or output", () => {
    const root = fixture();
    const lock = new Database(join(root, "dist/.backend-build-lock.sqlite"), { timeout: 0 });
    try {
      lock.exec("BEGIN EXCLUSIVE");
      const result = build(root);
      expect(result.status).toBe(1); expect(result.stderr).toContain("BACKEND_BUILD_ACTIVE");
      expect(readFileSync(join(root, "dist/build-metadata.json"), "utf8")).toBe("old metadata\n");
      expect(readFileSync(join(root, "dist/src/orphan.js"), "utf8")).toBe("old output\n");
      expect(readdirSync(join(root, "dist")).filter(name => name.startsWith(".backend-stage-"))).toEqual([]);
    } finally { lock.exec("ROLLBACK"); lock.close(); }
    successful(root);
  }, 25_000);

  it("releases the build lock when its owning Node process is killed", async () => {
    const root = fixture();
    const owner = spawn(process.execPath, ["--input-type=module", "-e",
      "import Database from './node_modules/better-sqlite3/lib/index.js'; "
      + "const db=new Database('dist/.backend-build-lock.sqlite',{timeout:0}); db.exec('BEGIN EXCLUSIVE'); "
      + "console.log('BUILD_LOCK_HELD'); process.stdin.resume();"], { cwd: root });
    try {
      const [chunk] = await Promise.race([once(owner.stdout, "data"),
        once(owner, "exit").then(() => { throw new Error("lock owner exited before readiness"); })]);
      expect(chunk.toString()).toContain("BUILD_LOCK_HELD");
      expect(build(root).stderr).toContain("BACKEND_BUILD_ACTIVE");
      const exited = once(owner, "exit"); owner.kill("SIGKILL"); await exited;
      successful(root);
    } finally {
      if (owner.exitCode === null && owner.signalCode === null) {
        const exited = once(owner, "exit"); owner.kill("SIGKILL"); await exited;
      }
    }
  }, 25_000);

  it.each([false, true])("preserves previous output on publication failure (restore fails=%s)", restoreFails => {
    const root = fixture(); const preload = join(root, "inject-rename.mjs");
    writeFileSync(preload, `import fs from 'node:fs'; import {sep} from 'node:path';
import {syncBuiltinESMExports} from 'node:module'; const rename = fs.renameSync;
fs.renameSync = (from,to) => { const name = String(from).split(sep).join('/');
if (name.endsWith('/compiled/contracts') || (${restoreFails} && name.endsWith('/prior/src'))) throw new Error('INJECTED_RENAME_FAILURE');
return rename(from,to); }; syncBuiltinESMExports();\n`);
    const result = spawnSync(process.execPath, ["--import", preload, join(root, "scripts/build-backend.mjs")],
      { cwd: root, encoding: "utf8", timeout: 20_000 });
    expect(result.status).toBe(1); expect(result.stderr).toContain("INJECTED_RENAME_FAILURE");
    expect(existsSync(join(root, "dist/build-metadata.json"))).toBe(false);
    const staging = readdirSync(join(root, "dist")).filter(name => name.startsWith(".backend-stage-"));
    if (restoreFails) {
      expect(result.stderr).toContain("BACKEND_BUILD_ROLLBACK_FAILED"); expect(staging).toHaveLength(1);
      expect(readFileSync(join(root, "dist", staging[0], "prior/src/orphan.js"), "utf8")).toBe("old output\n");
    } else {
      expect(staging).toEqual([]);
      expect(readFileSync(join(root, "dist/src/orphan.js"), "utf8")).toBe("old output\n");
    }
    expect(readFileSync(join(root, "dist/dashboard/index.html"), "utf8")).toBe("independent dashboard\n");
  }, 25_000);

  it("still restores previous output when manifest cleanup itself fails", () => {
    const root = fixture(); const preload = join(root, "inject-metadata.mjs");
    writeFileSync(preload, `import fs from 'node:fs'; import {syncBuiltinESMExports} from 'node:module';
const rename = fs.renameSync; fs.renameSync = (from,to) => {
if (String(from).endsWith('build-metadata.json')) fs.mkdirSync(to);
return rename(from,to); }; syncBuiltinESMExports();\n`);
    const result = spawnSync(process.execPath, ["--import", preload, join(root, "scripts/build-backend.mjs")],
      { cwd: root, encoding: "utf8", timeout: 20_000 });
    expect(result.status).toBe(1); expect(result.stderr).toContain("BACKEND_BUILD_METADATA_CLEANUP_FAILED");
    expect(readFileSync(join(root, "dist/src/orphan.js"), "utf8")).toBe("old output\n");
    expect(readFileSync(join(root, "dist/dashboard/index.html"), "utf8")).toBe("independent dashboard\n");
    expect(readdirSync(join(root, "dist")).filter(name => name.startsWith(".backend-stage-"))).toHaveLength(1);
  }, 25_000);
});
