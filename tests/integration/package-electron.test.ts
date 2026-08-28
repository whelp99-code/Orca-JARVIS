import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SCRIPT = join(process.cwd(), "scripts", "package-electron.mjs");

function run(env: NodeJS.ProcessEnv) {
  const result = spawnSync(process.execPath, [SCRIPT], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe("Electron package contract", () => {
  it("describes a sandboxed remote-only CLI-JAW shell", () => {
    // Given
    const env = {
      ELECTRON_DESCRIBE: "1",
      JARVIS_AUTHORITY_URL: "https://linux-authority.example.test",
    };

    // When
    const result = run(env);
    const described: unknown = JSON.parse(result.stdout);

    // Then
    expect(result.status).toBe(0);
    expect(described).toMatchObject({
      authority_mode: "remote-only",
      authority_url: env.JARVIS_AUTHORITY_URL,
      shell: "cli-jaw",
      electron_version: "44.0.0",
      web_preferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
  });

  it("rejects an invalid explicit Electron resolution", () => {
    // Given
    const env = {
      ELECTRON_BINARY: "/definitely/missing/electron",
      JARVIS_AUTHORITY_URL: "https://linux-authority.example.test",
      JARVIS_PRODUCT_HOME: "/tmp/task-5-invalid-electron",
    };

    // When
    const result = run(env);

    // Then
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("ELECTRON_BINARY_INVALID");
  });

  it("rejects authority-bearing local runtime configuration", () => {
    // Given
    const env = {
      ELECTRON_DESCRIBE: "1",
      JARVIS_AUTHORITY_URL: "https://linux-authority.example.test",
      JARVIS_RUNTIME_HOME: "/tmp/local-runtime",
    };

    // When
    const result = run(env);

    // Then
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("ELECTRON_LOCAL_AUTHORITY_FORBIDDEN");
  });
});
