import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const fixtureDir = dirname(fileURLToPath(import.meta.url));
const wheelPath = join(fixtureDir, "task30/second_brain-1.0.7-py3-none-any.whl");
const venvRoot = join(tmpdir(), "orca-jarvis-task30-provider-venv");

/** Pinned provider commit the vendored wheel was built from. */
export const TASK30_PROVIDER_SHA = "7336527bb1040c42b5ae5c33136f22ea33abb88b";

export function task30Wheel(): string {
  if (!existsSync(wheelPath)) throw new Error("TASK30_PROVIDER_WHEEL_REQUIRED");
  return wheelPath;
}

export function task30Sqlite(): string {
  const fromEnv = process.env["TASK30_SQLITE_CLI"];
  if (fromEnv !== undefined && fromEnv !== "") return fromEnv;
  const found = spawnSync("sh", ["-c", "command -v sqlite3"], { encoding: "utf8" });
  const path = found.stdout.trim();
  if (found.status === 0 && path !== "" && existsSync(path)) return path;
  throw new Error("TASK30_SQLITE_CLI_REQUIRED");
}

function uvBin(): string {
  return process.env["JARVIS_UV"] ?? "uv";
}

/** Isolated CPython with the vendored wheel installed. Reused for the process lifetime. */
export function task30Python(): string {
  const python = join(venvRoot, "bin/python");
  if (existsSync(python)) return python;
  mkdirSync(dirname(venvRoot), { recursive: true });
  const created = spawnSync(uvBin(), ["venv", venvRoot, "--python", "3.12"], { encoding: "utf8" });
  if (created.status !== 0) {
    throw new Error(`TASK30_PROVIDER_PYTHON_REQUIRED:${created.stderr}`);
  }
  const wheel = task30Wheel();
  const installed = spawnSync(uvBin(), [
    "pip", "install", "--python", python, "--link-mode", "copy", "--no-deps", wheel,
  ], { encoding: "utf8" });
  if (installed.status !== 0) throw new Error(`TASK30_PROVIDER_WHEEL_REQUIRED:${installed.stderr}`);
  const deps = spawnSync(uvBin(), [
    "pip", "install", "--python", python, "--link-mode", "copy",
    "cryptography", "pydantic", "mcp", "anyio", "pyyaml", "typing_extensions",
  ], { encoding: "utf8", timeout: 180_000 });
  if (deps.status !== 0) throw new Error(`TASK30_PROVIDER_PYTHON_REQUIRED:${deps.stderr}`);
  return python;
}
