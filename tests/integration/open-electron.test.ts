import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SCRIPT = join(process.cwd(), "scripts", "open-electron.mjs");

function run(env: NodeJS.ProcessEnv) {
  const result = spawnSync(process.execPath, [SCRIPT], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe("open Electron as a Linux-authority client", () => {
  it("prints bounded help without requiring authority", () => {
    // Given / When
    const result = spawnSync(process.execPath, [SCRIPT, "--help"], { encoding: "utf8", env: { ...process.env,
      JARVIS_AUTHORITY_URL: "", JARVIS_DB: "/forbidden" } });
    // Then
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Usage:");
    expect(result.stderr).toBe("");
  });

  it("rejects malformed private links before authority access", () => {
    // Given / When
    const result = spawnSync(process.execPath, [SCRIPT, "jarvis://evil/today"], { encoding: "utf8", env: {
      ...process.env, JARVIS_AUTHORITY_URL: "http://127.0.0.1:1", ELECTRON_BINARY: process.execPath,
    } });
    // Then
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("ELECTRON_DEEP_LINK_INVALID");
  });

  it("fails when the Linux authority URL is absent", () => {
    // Given
    const env = { JARVIS_AUTHORITY_URL: "", ELECTRON_BINARY: process.execPath };

    // When
    const result = run(env);

    // Then
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("LINUX_AUTHORITY_URL_REQUIRED");
  });

  it("rejects a local AuthorityDb fallback attempt", () => {
    // Given
    const env = {
      JARVIS_AUTHORITY_URL: "http://linux-authority.invalid:4174",
      JARVIS_DB: "/tmp/local-authority.sqlite",
      ELECTRON_BINARY: process.execPath,
    };

    // When
    const result = run(env);

    // Then
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("ELECTRON_LOCAL_AUTHORITY_FORBIDDEN");
  });

  it("fails closed when Linux authority is unreachable", () => {
    // Given
    const env = {
      JARVIS_AUTHORITY_URL: "http://127.0.0.1:1",
      ELECTRON_BINARY: process.execPath,
    };

    // When
    const result = run(env);

    // Then
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("LINUX_AUTHORITY_UNAVAILABLE");
    expect(result.stdout).not.toContain("launched");
  });
});
