import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

type Packaged = Readonly<{
  app_resources: string;
  electron_binary: string;
  package_path: string;
}>;

function parsePackaged(value: unknown): Packaged {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TypeError("invalid package output");
  const record = Object.fromEntries(Object.entries(value));
  if (typeof record.app_resources !== "string" || typeof record.electron_binary !== "string"
    || typeof record.package_path !== "string") throw new TypeError("invalid package output");
  return {
    app_resources: record.app_resources,
    electron_binary: record.electron_binary,
    package_path: record.package_path,
  };
}

describe("real Electron package", () => {
  it("contains Electron 44 and only the configured Linux authority", () => {
    // Given
    const home = mkdtempSync(join(tmpdir(), "jarvis-electron-real-"));
    const authorityUrl = "https://linux-authority.example.test";
    try {
      // When
      const packaged = parsePackaged(JSON.parse(execFileSync(process.execPath, [
        join(process.cwd(), "scripts", "package-electron.mjs"),
      ], {
        encoding: "utf8",
        env: {
          ...process.env,
          JARVIS_AUTHORITY_URL: authorityUrl,
          JARVIS_PRODUCT_HOME: home,
        },
      })));
      const client: unknown = JSON.parse(readFileSync(
        join(packaged.app_resources, "app", "client-config.json"),
        "utf8",
      ));
      const main = readFileSync(join(packaged.app_resources, "app", "main.cjs"), "utf8");
      const version = execFileSync(packaged.electron_binary, ["--no-sandbox", "--version"], { encoding: "utf8" }).trim();

      // Then
      expect(version).toBe("v44.0.0");
      expect(client).toEqual({
        schema_version: 1,
        authority_mode: "remote-only",
        authority_url: authorityUrl,
        shell: "cli-jaw",
        client_host: "host:pos:mac-client",
        protocol_scheme: "jarvis",
      });
      expect(main).toContain("requestSingleInstanceLock");
      expect(main).toContain("/api/v1/notification-deliveries/claim");
      expect(main).not.toMatch(/AuthorityDb|better-sqlite3|jarvis-authority|local-authority/u);
      expect(JSON.stringify(client)).not.toMatch(/AuthorityDb|better-sqlite3|jarvis-authority/u);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
});
