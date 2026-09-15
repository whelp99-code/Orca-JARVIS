import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { probeSecondBrainConfiguration } from "../../src/second-brain-readiness-config.js";
import { evaluateSecondBrainReadiness, passiveSecondBrainReadinessProbe,
  type SecondBrainReadinessObservation } from "../../src/second-brain-readiness.js";
import { runtimeSecondBrainReadinessProbe,
  type SecondBrainReadinessRunner } from "../../src/second-brain-readiness-runtime.js";

const VAULT = '"vault_root" = "/safe/vault"\n';
const KEY_ID = "provider:second-brain:example";
const PUBLIC_KEY = "XXVhfb4KsZh38gyMmNumCTSFNBgMVtRqSdoo_Ao81n0";
const NOW = new Date("2026-09-15T00:00:00.000Z");

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function configuration(text: string): string {
  const root = mkdtempSync(join(tmpdir(), "jarvis-provider-result-key-")); roots.push(root);
  const path = join(root, "config.toml");
  writeFileSync(path, text);
  return path;
}

describe("the configured provider signing key id has a public key on file", () => {
  it("accepts a configuration whose result key is on file", async () => {
    const path = configuration(`${VAULT}"provider_signing_key_id" = "${KEY_ID}"\n`
      + `\n[provider_result_public_keys]\n"${KEY_ID}" = "${PUBLIC_KEY}"\n`);
    await expect(probeSecondBrainConfiguration(path)).resolves.toBe("valid");
  });

  it.each([
    ["no table at all", ""],
    ["a table naming another key id", `\n[provider_result_public_keys]\n"other:key" = "${PUBLIC_KEY}"\n`],
    ["an empty public key", `\n[provider_result_public_keys]\n"${KEY_ID}" = ""\n`],
    ["a public key that is not a string", `\n[provider_result_public_keys]\n"${KEY_ID}" = 1\n`],
  ])("reports the missing entry rather than a signature failure later (%s)", async (_name, table) => {
    const path = configuration(`${VAULT}"provider_signing_key_id" = "${KEY_ID}"\n${table}`);
    await expect(probeSecondBrainConfiguration(path)).resolves.toBe("result_key_missing");
  });

  it("keeps a configuration that names no provider signing key id valid", async () => {
    await expect(probeSecondBrainConfiguration(configuration(VAULT))).resolves.toBe("valid");
  });

  it("refuses a configuration whose provider signing key id is not a non-empty string", async () => {
    for (const value of ['""', "true", "[]"]) {
      const path = configuration(`${VAULT}"provider_signing_key_id" = ${value}\n`);
      await expect(probeSecondBrainConfiguration(path)).resolves.toBe("malformed");
    }
  });
});

describe("readiness fails closed on the missing result key", () => {
  const observation = async (configured: SecondBrainReadinessObservation["configuration"]) => ({
    ...await passiveSecondBrainReadinessProbe().inspect(),
    executable: "available" as const, configuration: configured,
  });

  it("names the omission and is not ready", async () => {
    const report = evaluateSecondBrainReadiness(await observation("result_key_missing"), NOW);
    expect(report).toMatchObject({ readiness: "unavailable", stages: { configured: {
      state: "malformed", reason: "configuration_provider_result_key_missing",
      checked_at: NOW.toISOString() } } });
  });

  it("keeps configuration_malformed for bytes that are not a configuration", async () => {
    expect(evaluateSecondBrainReadiness(await observation("malformed"), NOW))
      .toMatchObject({ stages: { configured: { reason: "configuration_malformed" } } });
  });

  it("stops the preflight before any provider probe runs", async () => {
    const attempted: string[] = [];
    const runner: SecondBrainReadinessRunner = {
      executable: () => Promise.resolve("available"),
      configuration: () => Promise.resolve("result_key_missing"),
      run: command => { attempted.push(command); return Promise.resolve({ kind: "ok", stdout: "" }); },
      handshake: () => { attempted.push("handshake"); return Promise.resolve({ kind: "ok", stdout: "" }); },
    };
    const inspected = await runtimeSecondBrainReadinessProbe(runner).inspect();
    expect(inspected.configuration).toBe("result_key_missing");
    expect(attempted).toEqual([]);
    expect(evaluateSecondBrainReadiness(inspected, NOW).readiness).toBe("unavailable");
  });
});
