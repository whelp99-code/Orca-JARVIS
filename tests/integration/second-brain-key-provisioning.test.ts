import { spawnSync } from "node:child_process";
import { createPrivateKey, generateKeyPairSync } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

const roots: string[] = [];
const SCRIPT = join(process.cwd(), "ops", "second-brain", "provision-request-executor-keys.mjs");

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "jarvis-key-provision-"));
  roots.push(root);
  writeFileSync(join(root, "config.toml"), [
    `vault_root = "${join(root, "vault")}"`,
    "sources = []",
    "",
    "[llm]",
    "mode = \"disabled\"",
    "",
  ].join("\n"), { mode: 0o600 });
  return root;
}

function run(root: string) {
  const result = spawnSync(process.execPath, [
    SCRIPT,
    "--fixture-root", root,
    "--provider-release-sha", "a".repeat(40),
    "--provider-instance-id", "provider:fixture:linux",
    "--apply",
  ], { encoding: "utf8", cwd: process.cwd() });
  return { ...result, parsed: result.status === 0 ? JSON.parse(result.stdout) as Record<string, unknown> : undefined };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Second Brain request-executor production key provisioning", () => {
  it("creates secure random Ed25519 keys, preserves TOML, cross-registers authority, and replays exactly", () => {
    const root = fixture();
    const first = run(root);
    const second = run(root);

    expect({ first: first.status, second: second.status, stderr: `${first.stderr}${second.stderr}` })
      .toEqual({ first: 0, second: 0, stderr: "" });
    expect(second.parsed).toMatchObject({
      ok: true,
      mode: "fixture",
      provider_instance_id: "provider:fixture:linux",
      provider_release_sha: "a".repeat(40),
      jarvis_key_id: first.parsed?.jarvis_key_id,
      provider_key_id: first.parsed?.provider_key_id,
      marker_enabled: true,
    });
    expect(`${first.stdout}${second.stdout}`).not.toMatch(/PRIVATE KEY|provider_private_key|jarvis_public_key/u);

    const config = readFileSync(join(root, "config.toml"), "utf8");
    expect(config).toContain("[llm]\nmode = \"disabled\"");
    for (const key of [
      "provider_instance_id",
      "provider_release_sha",
      "provider_signing_key_id",
      "provider_private_key",
      "jarvis_signing_key_id",
      "jarvis_public_key",
    ]) expect(config.match(new RegExp(`^${key} = `, "gmu"))).toHaveLength(1);

    for (const name of ["jarvis-delegation-private.pem", "provider-proof-private.pem"]) {
      const path = join(root, "keys", name);
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(createPrivateKey(readFileSync(path)).asymmetricKeyType).toBe("ed25519");
    }
    expect(statSync(join(root, "keys")).mode & 0o777).toBe(0o700);
    expect(statSync(join(root, "request-executor-keys.json")).mode & 0o777).toBe(0o600);
    expect(statSync(join(root, "request-executor.enabled")).mode & 0o777).toBe(0o600);

    const db = new Database(join(root, "jarvis.sqlite"), { readonly: true, fileMustExist: true });
    try {
      expect(db.prepare("SELECT key_id,state FROM memory_effect_delegation_keys").all()).toEqual([
        { key_id: first.parsed?.jarvis_key_id, state: "active" },
      ]);
      expect(db.prepare(
        "SELECT key_id,provider_instance_id,provider_release_sha,state FROM memory_provider_proof_keys",
      ).all()).toEqual([{
        key_id: first.parsed?.provider_key_id,
        provider_instance_id: "provider:fixture:linux",
        provider_release_sha: "a".repeat(40),
        state: "active",
      }]);
    } finally {
      db.close();
    }
  });

  it("fails closed for production overrides and insecure pre-existing key permissions", () => {
    const productionOverride = spawnSync(process.execPath, [
      SCRIPT, "--production", "--provider-release-sha", "a".repeat(40), "--apply",
    ], { encoding: "utf8", cwd: process.cwd() });
    expect(productionOverride.status).toBe(2);
    expect(productionOverride.stderr).toContain("REQUEST_EXECUTOR_KEY_PRODUCTION_OVERRIDE_FORBIDDEN");

    const root = fixture();
    mkdirSync(join(root, "keys"), { mode: 0o700 });
    const privateKey = generateKeyPairSync("ed25519").privateKey.export({ format: "pem", type: "pkcs8" });
    const path = join(root, "keys", "jarvis-delegation-private.pem");
    writeFileSync(path, privateKey, { mode: 0o644 });
    chmodSync(path, 0o644);
    const insecure = run(root);
    expect(insecure.status).toBe(2);
    expect(insecure.stderr).toContain("REQUEST_EXECUTOR_KEY_PATH_UNSAFE");
    expect(insecure.stdout).toBe("");
  });
});
