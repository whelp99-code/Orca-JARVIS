import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
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
  it("pins every locked install script and runs the locked Electron installer before packaging", () => {
    const packageJson: unknown = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8"));
    const packageLock: unknown = JSON.parse(readFileSync(join(process.cwd(), "package-lock.json"), "utf8"));
    expect(packageJson).toBeTypeOf("object");
    expect(packageLock).toBeTypeOf("object");

    const metadata = packageJson as {
      allowScripts?: Record<string, boolean>;
      scripts?: Record<string, string>;
    };
    const lock = packageLock as {
      packages?: Record<string, { hasInstallScript?: boolean; version?: string }>;
    };
    const lockedInstallers = Object.entries(lock.packages ?? {})
      .filter(([, entry]) => entry.hasInstallScript === true)
      .map(([path, entry]) => {
        const name = path.slice(path.lastIndexOf("node_modules/") + "node_modules/".length);
        return `${name}@${entry.version}`;
      })
      .sort();

    expect(lockedInstallers).toEqual([
      "better-sqlite3@12.11.1",
      "esbuild@0.28.2",
      "fsevents@2.3.2",
      "fsevents@2.3.3",
    ]);
    expect(metadata.allowScripts).toEqual(Object.fromEntries(lockedInstallers.map((key) => [key, true])));
    expect(metadata.scripts?.["product:install-electron"]).toBe("install-electron");
    expect(metadata.scripts?.["preproduct:package-electron"]).toBe("npm run product:install-electron");
  });

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
