import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, openSync, closeSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { BACKEND_OUTPUT_ROOTS, backendSourceIdentity, fileIdentity } from "./lib/backend-build-identity.mjs";

const { values } = parseArgs({ options: { "output-parent": { type: "string" } }, strict: true });
if (!values["output-parent"]) throw new Error("RUNTIME_PACKAGE_OUTPUT_PARENT_REQUIRED");
const root = process.cwd();
const parent = resolve(values["output-parent"]);
const roots = ["dist/src", "dist/tests", "dist/migrations", "dist/contracts", "dist/dashboard",
  "dist/build-metadata.json", "migrations", "config", "package.json", "package-lock.json"];
let output;
function run(command, args, cwd, log, env = process.env) {
  const fd = openSync(log, "wx", 0o600);
  try {
    const result = spawnSync(command, args, { cwd, env, stdio: ["ignore", fd, fd] });
    if (result.error || result.signal || result.status !== 0) throw new Error("RUNTIME_PACKAGE_COMMAND_FAILED");
  } finally { closeSync(fd); }
}
try {
  // mkdtemp never reuses an existing output directory or updates a release pointer.
  output = mkdtempSync(join(parent, "jarvis-runtime-"));
  run("npm", ["run", "build"], root, join(output, "build.log"));
  const source = backendSourceIdentity(root);
  const metadata = JSON.parse(readFileSync(join(root, "dist/build-metadata.json"), "utf8"));
  if (JSON.stringify(metadata.source) !== JSON.stringify(source)
    || metadata.artifact.digest !== fileIdentity(join(root, "dist"), BACKEND_OUTPUT_ROOTS).digest) {
    throw new Error("RUNTIME_PACKAGE_BUILD_IDENTITY_MISMATCH");
  }
  // Required roots must exist even though fileIdentity permits optional roots.
  for (const name of roots) readFileOrDirectory(name);
  const before = fileIdentity(root, roots);
  for (const name of roots) {
    mkdirSync(resolve(output, name, ".."), { recursive: true });
    cpSync(join(root, name), join(output, name), { recursive: true, errorOnExist: true, force: false });
  }
  if (fileIdentity(output, roots).digest !== before.digest) throw new Error("RUNTIME_PACKAGE_COPY_MISMATCH");
  run("npm", ["ci", "--omit=dev", "--offline", "--no-audit", "--no-fund"], output,
    join(output, "dependency-install.log"));
  mkdirSync(join(output, "smoke-state"));
  run(process.execPath, [join(root, "scripts/cli-smoke.mjs")], output, join(output, "cli-smoke.log"),
    { ...process.env, TMPDIR: join(output, "smoke-state") });
  const identityDb = join(output, "identity-must-not-create.sqlite");
  const identityLog = join(output, "runtime-identity.json");
  run(process.execPath, ["dist/src/cli.js", "runtime", "identity", "--db", identityDb], output, identityLog);
  const observed = JSON.parse(readFileSync(identityLog, "utf8"));
  const build = observed.observer?.build;
  if (observed.ok !== true || observed.command !== "runtime.identity" || build?.status !== "matched"
    || build.toolchain_status !== "matched" || build.source_head !== source.head
    || build.input_digest !== source.input_digest || build.artifact_digest !== metadata.artifact.digest
    || build.observed_artifact_digest !== metadata.artifact.digest || existsSync(identityDb)) {
    throw new Error("RUNTIME_PACKAGE_OBSERVED_IDENTITY_MISMATCH");
  }
  if (JSON.stringify(source) !== JSON.stringify(backendSourceIdentity(root))
    || fileIdentity(root, roots).digest !== before.digest
    || fileIdentity(output, roots).digest !== before.digest) throw new Error("RUNTIME_PACKAGE_INPUT_CHANGED");
  const receipt = { schema_version: 1, kind: "isolated-authority-runtime-package", source,
    payload: before, validation: { production_dependency_install: "passed", cli_smoke: "passed", runtime_identity: "passed",
      dashboard: "not_performed", provider: "not_performed", reproducibility: "not_performed" },
    deployment_ready: false };
  writeFileSync(join(output, "runtime-package-receipt.json"), `${JSON.stringify(receipt)}\n`, { flag: "wx", mode: 0o600 });
  process.stdout.write(`${JSON.stringify({ ok: true, output, source_head: source.head,
    source_dirty: source.dirty, payload_files: before.file_count, deployment_ready: false })}\n`);
} catch (error) {
  process.stderr.write(`${JSON.stringify({ ok: false, output, code: error.message })}\n`);
  process.exitCode = 1;
}

function readFileOrDirectory(name) {
  // Fail before copying any input if a required root is missing.
  const identity = fileIdentity(root, [name]);
  if (identity.file_count === 0) throw new Error("RUNTIME_PACKAGE_REQUIRED_ROOT_MISSING");
}
