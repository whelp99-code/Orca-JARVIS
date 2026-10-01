import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PersonalOsError } from "./personal-os-errors.js";
import {
  FORGOTTEN_SENTINEL,
  PROVIDER_SOURCE_COMMIT,
  PROVIDER_SOURCE_DEFAULT,
  PROVIDER_WHEEL_SHA256,
} from "./personal-os-rehearsal-contract.js";
import { activateCurrent, placeRelease } from "./personal-os-rehearsal-release.js";
import { writeReleaseManifest } from "./personal-os-release-manifest.js";
import { mcpHandshakeGate } from "./release-health-gates.js";

export type ProviderInstall = {
  readonly wheelSha256: string;
  readonly sourceCommit: string;
  readonly launcher: string;
  readonly configPath: string;
  readonly vaultRoot: string;
  readonly payloadDigest: string;
  readonly currentTarget: string;
  readonly venv: string;
};

function uvBin(): string {
  return process.env["JARVIS_UV"] ?? "uv";
}

function run(command: string, args: readonly string[], cwd?: string): void {
  const result = spawnSync(command, [...args], { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new PersonalOsError("E_REHEARSAL_GATE");
}

function script(path: string, body: string): void {
  writeFileSync(path, body, { mode: 0o700 });
  chmodSync(path, 0o700);
}

const PROVIDER_BUNDLE = fileURLToPath(new URL("../vendor/task30-provider.bundle", import.meta.url));
let vendoredSource: string | undefined;

/** Prefer an explicit checkout, then the owner worktree, then the vendored pin. CI has no /home/jm path. */
export function resolveProviderSource(sourceRoot?: string): string {
  if (sourceRoot !== undefined) return sourceRoot;
  const fromEnv = process.env["JARVIS_REHEARSAL_PROVIDER_SOURCE"];
  if (fromEnv !== undefined && fromEnv !== "") return fromEnv;
  if (existsSync(PROVIDER_SOURCE_DEFAULT)) return PROVIDER_SOURCE_DEFAULT;
  if (vendoredSource !== undefined && existsSync(join(vendoredSource, ".git"))) return vendoredSource;
  if (!existsSync(PROVIDER_BUNDLE)) throw new PersonalOsError("E_REHEARSAL_GATE");
  const root = mkdtempSync(join(tmpdir(), "task30-provider-source-"));
  const cloned = spawnSync("git", ["clone", "--quiet", PROVIDER_BUNDLE, root], { encoding: "utf8" });
  if (cloned.status !== 0) throw new PersonalOsError("E_REHEARSAL_GATE");
  const checked = spawnSync("git", ["-C", root, "checkout", "--quiet", PROVIDER_SOURCE_COMMIT], { encoding: "utf8" });
  if (checked.status !== 0) throw new PersonalOsError("E_REHEARSAL_GATE");
  vendoredSource = root;
  return root;
}

export function installProviderRelease(input: {
  readonly releaseRoot: string;
  readonly sourceRoot?: string;
}): ProviderInstall {
  const source = resolveProviderSource(input.sourceRoot);
  const head = spawnSync("git", ["-C", source, "rev-parse", "HEAD"], { encoding: "utf8" });
  if (head.status !== 0 || head.stdout.trim() !== PROVIDER_SOURCE_COMMIT) throw new PersonalOsError("E_REHEARSAL_GATE");
  const wheelDir = join(input.releaseRoot, "wheel-build");
  mkdirSync(wheelDir, { recursive: true });
  run(uvBin(), ["build", "--wheel", "-o", wheelDir], source);
  const wheels = readdirSync(wheelDir).filter(name => name.endsWith(".whl"));
  const wheelName = wheels[0];
  if (wheelName === undefined) throw new PersonalOsError("E_REHEARSAL_GATE");
  const wheel = join(wheelDir, wheelName);
  const wheelSha256 = createHash("sha256").update(readFileSync(wheel)).digest("hex");
  if (wheelSha256 !== PROVIDER_WHEEL_SHA256) throw new PersonalOsError("E_REHEARSAL_GATE");
  const venv = join(input.releaseRoot, "provider-venv");
  run(uvBin(), ["venv", venv, "--python", "3.12"]);
  run(uvBin(), ["pip", "install", "--python", join(venv, "bin/python"), "--link-mode", "copy", wheel]);
  const share = join(input.releaseRoot, "provider-share");
  const state = join(input.releaseRoot, "provider-state");
  const configDir = join(input.releaseRoot, "provider-config");
  mkdirSync(join(share, "vault"), { recursive: true });
  mkdirSync(state, { recursive: true });
  mkdirSync(configDir, { recursive: true });
  const configPath = join(configDir, "config.toml");
  writeFileSync(configPath, [
    `vault_root = "${join(share, "vault")}"`,
    `state_root = "${state}"`,
    `share_root = "${share}"`,
    `request_root = "${join(state, "requests")}"`,
    `export_root = "${join(state, "exports")}"`,
    `backup_root = "${join(state, "backups")}"`,
    `generation_root = "${join(share, "vault-generations")}"`,
    `provider_instance_id = "provider:second-brain:rehearsal"`,
    `provider_release_sha = "${PROVIDER_SOURCE_COMMIT}"`,
    "",
  ].join("\n"));
  const stage = join(input.releaseRoot, "provider-stage");
  const bin = join(stage, "bin");
  mkdirSync(bin, { recursive: true });
  const python = join(venv, "bin/python");
  const preamble = [
    "#!/bin/sh", "set -eu", `export HOME="${share}"`, `export XDG_STATE_HOME="${state}"`,
    `export XDG_DATA_HOME="${share}"`, `export XDG_CONFIG_HOME="${configDir}"`,
    `export SB_CONFIG="${configPath}"`, "",
  ].join("\n");
  const profile = "export SB_MCP_CONTRACT_PROFILE=\"${SB_MCP_CONTRACT_PROFILE:-task32-schema4}\"\n";
  script(join(bin, "second-brain-mcp"), `${preamble}${profile}exec ${JSON.stringify(python)} -m sb.mcp "$@"\n`);
  script(join(bin, "sb"), `${preamble}exec ${JSON.stringify(python)} -m sb.cli "$@"\n`);
  writeFileSync(join(stage, "wheel.sha256"), `${wheelSha256}  ${wheelName}\n`);
  const written = writeReleaseManifest({
    root: stage,
    artifact: "second-brain-provider",
    source: {
      commit: PROVIDER_SOURCE_COMMIT,
      tree: PROVIDER_SOURCE_COMMIT,
      first_parent: PROVIDER_SOURCE_COMMIT,
      subject: "task-30 provider wheel",
      commit_timestamp: "2026-09-28T00:00:00.000Z",
      archive_digest: wheelSha256,
    },
    build: {
      source_date_epoch: 0,
      builder_command: "uv build --wheel",
      offline_cache_digest: wheelSha256,
      lifecycle_command_digests: [wheelSha256],
      reproducibility_receipt: wheelSha256,
    },
    sidecarDir: join(input.releaseRoot, "manifests"),
  });
  const providerRoot = join(input.releaseRoot, "provider-releases");
  const placed = placeRelease({ stage, runtimeRoot: providerRoot, sha: PROVIDER_SOURCE_COMMIT });
  const currentTarget = activateCurrent(providerRoot, PROVIDER_SOURCE_COMMIT);
  return {
    wheelSha256,
    sourceCommit: PROVIDER_SOURCE_COMMIT,
    launcher: join(placed.release, "bin/second-brain-mcp"),
    configPath,
    vaultRoot: join(share, "vault"),
    payloadDigest: written.manifest.payload_digest,
    currentTarget,
    venv,
  };
}

export async function handshakeProvider(install: ProviderInstall): Promise<{
  readonly ok: boolean;
  readonly code: string | null;
  readonly protocol: unknown;
}> {
  const gate = await mcpHandshakeGate({ launcherPath: install.launcher, configPath: install.configPath });
  return { ok: gate.ok, code: gate.code ?? null, protocol: gate.actual };
}

export function replayTombstoneGeneration(input: {
  readonly python: string;
  readonly shareRoot: string;
  readonly sentinel?: string;
}): { readonly ok: boolean; readonly deletion_leak: number; readonly activated: boolean; readonly detail: unknown } {
  const sentinel = input.sentinel ?? FORGOTTEN_SENTINEL;
  const driver = join(input.shareRoot, "replay-tombstone.py");
  writeFileSync(driver, TOMBSTONE_DRIVER);
  const result = spawnSync(input.python, [driver, input.shareRoot, sentinel], { encoding: "utf8" });
  if (result.status !== 0) return { ok: false, deletion_leak: 1, activated: false, detail: result.stderr };
  const parsed: unknown = JSON.parse(result.stdout);
  if (typeof parsed !== "object" || parsed === null) return { ok: false, deletion_leak: 1, activated: false, detail: parsed };
  const record = parsed as Record<string, unknown>;
  const leak = Number(record["deletion_leak"]);
  const activated = record["activated_after_replay"] === true;
  return {
    ok: record["ok"] === true && leak === 0 && activated,
    deletion_leak: Number.isFinite(leak) ? leak : 1,
    activated,
    detail: parsed,
  };
}

const TOMBSTONE_DRIVER = `import json, os, shutil, subprocess, sys
from pathlib import Path
from sb.ops import create_backup, restore_backup
from sb.vault import Vault, init_vault

def commit(root: Path, message: str) -> None:
    env = os.environ.copy()
    env.update({"GIT_CONFIG_GLOBAL": os.devnull, "GIT_CONFIG_SYSTEM": os.devnull,
                "GIT_AUTHOR_NAME": "rehearsal", "GIT_AUTHOR_EMAIL": "rehearsal@example.invalid",
                "GIT_COMMITTER_NAME": "rehearsal", "GIT_COMMITTER_EMAIL": "rehearsal@example.invalid"})
    subprocess.run(["git", "-C", str(root), "add", "wiki/task36-sentinel.md"], check=True, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    subprocess.run(["git", "-C", str(root), "commit", "-m", message], check=True, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

share = Path(sys.argv[1])
sentinel = sys.argv[2]
g1 = share / "generations" / "g1"
g3 = share / "generations" / "g3"
init_vault(g1)
page = g1 / "wiki" / "task36-sentinel.md"
page.write_text("---\\nid: wiki/task36-sentinel\\ntitle: sentinel\\nstatus: active\\nsources: []\\n---\\n" + sentinel + "\\n", encoding="utf-8")
commit(g1, "seed sentinel")
archive = share / "g1.tar.gz"
create_backup(g1, archive)
forgotten = Vault(g1).forget_page("wiki/task36-sentinel")
shutil.rmtree(g1)
restore_backup(archive, g3)
resurrected = sentinel in (g3 / "wiki" / "task36-sentinel.md").read_text(encoding="utf-8")
replayed = Vault(g3).forget_page("wiki/task36-sentinel")
pages = [path for path in g3.rglob("*") if path.is_file() and ".git" not in path.parts]
leak = sum(path.read_text(encoding="utf-8", errors="ignore").count(sentinel) for path in pages)
active = share / "vault"
if active.is_symlink() or active.is_file():
    active.unlink()
elif active.exists():
    shutil.rmtree(active)
if leak == 0 and resurrected and replayed is not None:
    active.symlink_to(g3.resolve())
print(json.dumps({"ok": leak == 0 and resurrected and active.is_symlink(), "deletion_leak": leak,
                  "activated_after_replay": active.is_symlink(), "resurrected_before_replay": resurrected,
                  "forget_commit": forgotten, "replay_commit": replayed}))
`;
