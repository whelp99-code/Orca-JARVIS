import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { execute } from "../../src/cli.js";
import { JarvisError } from "../../src/db.js";
import { canonicalPath, resolveRuntimeLocation } from "../../src/runtime-home.js";
import { externalAnchors } from "../helpers.js";

const AUTHORITY_DB = "jarvis.sqlite";

function tempRoot(label: string): string {
  return mkdtempSync(join(tmpdir(), label));
}

function cleanEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.JARVIS_RUNTIME_HOME;
  delete env.JARVIS_DB;
  delete env.JARVIS_TEST_RUNTIME_HOME;
  return env;
}

function launchAgentXml(authorityDb: string): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<plist version="1.0"><dict>',
    "<key>Label</key><string>com.jmpark.orca-jarvis</string>",
    "<key>ProgramArguments</key><array>",
    "<string>/usr/bin/node</string>",
    "<string>/opt/jarvis/dist/src/cli.js</string>",
    "<string>service</string><string>run</string>",
    "<string>--db</string>",
    `<string>${authorityDb}</string>`,
    "</array></dict></plist>",
    "",
  ].join("\n");
}

describe("runtime home discovery", () => {
  it("uses an explicit CLI database path without consulting cwd", () => {
    const root = tempRoot("jarvis-runtime-cli-");
    const authorityDb = join(root, "custom.sqlite");
    const location = resolveRuntimeLocation({
      cliAuthorityDb: authorityDb,
      cwd: join(root, "unrelated"),
      env: cleanEnv(),
      servicePlistPath: join(root, "missing.plist"),
    });
    expect(location).toMatchObject({
      authorityDb: canonicalPath(authorityDb),
      runtimeHome: canonicalPath(root),
      source: "cli",
    });
  });

  it("maps JARVIS_RUNTIME_HOME to the authority database basename", () => {
    const home = tempRoot("jarvis-runtime-env-");
    const location = resolveRuntimeLocation({
      env: { ...cleanEnv(), JARVIS_RUNTIME_HOME: home },
      cwd: join(home, "elsewhere"),
      servicePlistPath: join(home, "missing.plist"),
    });
    expect(location).toEqual({
      runtimeHome: canonicalPath(home),
      authorityDb: canonicalPath(join(home, AUTHORITY_DB)),
      source: "env",
    });
  });

  it("refuses conflicting explicit runtime home and database before any file is created", async () => {
    const home = tempRoot("jarvis-runtime-conflict-home-");
    const other = tempRoot("jarvis-runtime-conflict-db-");
    const authorityDb = join(other, AUTHORITY_DB);
    const beforeHome = statSync(home);
    expect(() =>
      resolveRuntimeLocation({
        env: {
          ...cleanEnv(),
          JARVIS_RUNTIME_HOME: home,
          JARVIS_DB: authorityDb,
        },
        cwd: other,
        servicePlistPath: join(home, "missing.plist"),
      }),
    ).toThrowError(expect.objectContaining({ code: "RUNTIME_HOME_CONFLICT" }) as JarvisError);

    await expect(
      execute(["init"], {
        runtimeDiscovery: {
          env: {
            ...cleanEnv(),
            JARVIS_RUNTIME_HOME: home,
            JARVIS_DB: authorityDb,
          },
          cwd: other,
          servicePlistPath: join(home, "missing.plist"),
        },
      }),
    ).rejects.toMatchObject({ code: "RUNTIME_HOME_CONFLICT" });

    expect(statSync(home).mtimeMs).toBe(beforeHome.mtimeMs);
    expect(() => statSync(authorityDb)).toThrow();
    expect(() => statSync(join(home, AUTHORITY_DB))).toThrow();
  });

  it("accepts JARVIS_DB when it is exactly the runtime-home authority database", () => {
    const home = tempRoot("jarvis-runtime-aligned-");
    const authorityDb = join(home, AUTHORITY_DB);
    const location = resolveRuntimeLocation({
      env: {
        ...cleanEnv(),
        JARVIS_RUNTIME_HOME: home,
        JARVIS_DB: authorityDb,
      },
      servicePlistPath: join(home, "missing.plist"),
    });
    expect(location.source).toBe("env");
    expect(location.authorityDb).toBe(canonicalPath(authorityDb));
  });

  it("reads installed service metadata when no explicit override is present", () => {
    const root = tempRoot("jarvis-runtime-service-");
    const home = join(root, ".jarvis-runtime");
    mkdirSync(home);
    const authorityDb = join(home, AUTHORITY_DB);
    const plist = join(root, "com.jmpark.orca-jarvis.plist");
    writeFileSync(plist, launchAgentXml(authorityDb));
    const location = resolveRuntimeLocation({
      env: cleanEnv(),
      cwd: join(root, "cwd"),
      servicePlistPath: plist,
    });
    expect(location).toMatchObject({
      runtimeHome: canonicalPath(home),
      authorityDb: canonicalPath(authorityDb),
      source: "service",
    });
  });

  it("uses a repository-local .jarvis-runtime when service metadata is absent", () => {
    const repo = tempRoot("jarvis-runtime-repo-");
    const nested = join(repo, "src", "cli");
    mkdirSync(nested, { recursive: true });
    const home = join(repo, ".jarvis-runtime");
    mkdirSync(home);
    writeFileSync(join(repo, "package.json"), "{\"name\":\"orca-jarvis-shadow\"}\n");
    const location = resolveRuntimeLocation({
      env: cleanEnv(),
      cwd: nested,
      servicePlistPath: join(repo, "missing.plist"),
    });
    expect(location).toMatchObject({
      runtimeHome: canonicalPath(home),
      authorityDb: canonicalPath(join(home, AUTHORITY_DB)),
      source: "repository",
    });
  });

  it("uses a labelled test runtime home as the last fallback", () => {
    const home = tempRoot("jarvis-runtime-test-");
    const location = resolveRuntimeLocation({
      env: { ...cleanEnv(), JARVIS_TEST_RUNTIME_HOME: home },
      cwd: tempRoot("jarvis-runtime-test-cwd-"),
      servicePlistPath: join(home, "missing.plist"),
    });
    expect(location).toEqual({
      runtimeHome: canonicalPath(home),
      authorityDb: canonicalPath(join(home, AUTHORITY_DB)),
      source: "test",
    });
  });

  it("creates init artifacts only inside an isolated runtime home", async () => {
    const parent = tempRoot("jarvis-runtime-init-");
    const home = join(parent, "home");
    const strayCwd = join(parent, "cwd");
    mkdirSync(home);
    mkdirSync(strayCwd);
    const anchors = externalAnchors();
    const result = await execute([
      "init",
      "--runtime-home",
      home,
      "--decision_public",
      anchors.decisionPublic,
      "--decision_key_id",
      "decision-anchor",
      "--decision_principal",
      "operator",
      "--verifier_public",
      anchors.verifierPublic,
      "--verifier_key_id",
      "verifier-anchor",
      "--verifier_principal",
      "verifier",
    ], {
      runtimeDiscovery: { env: cleanEnv(), cwd: strayCwd, servicePlistPath: join(parent, "missing.plist") },
    });
    expect(result).toMatchObject({ ok: true, command: "init" });
    expect(statSync(join(home, AUTHORITY_DB)).isFile()).toBe(true);
    expect(() => statSync(join(strayCwd, "jarvis-authority.sqlite"))).toThrow();
    expect(() => statSync(join(strayCwd, AUTHORITY_DB))).toThrow();
    rmSync(parent, { recursive: true, force: true });
  });

  it("returns the same doctor database identity from three unrelated cwd values", async () => {
    const root = tempRoot("jarvis-runtime-doctor-");
    const home = join(root, ".jarvis-runtime");
    mkdirSync(home);
    const authorityDb = join(home, AUTHORITY_DB);
    await execute(["db", "migrate", "--runtime-home", home], {
      runtimeDiscovery: { env: cleanEnv(), servicePlistPath: join(root, "missing.plist") },
    });
    const plist = join(root, "agent.plist");
    writeFileSync(plist, launchAgentXml(authorityDb));
    const cwds = [0, 1, 2].map(index => {
      const dir = join(root, `cwd-${index}`);
      mkdirSync(dir);
      return dir;
    });
    const reports = [];
    const capabilityProbe = {
      inspect: async () => ({
        installed: { ok: false, version: null, evidence: "missing_executable" },
        configured: { ok: false, evidence: "configuration_unverified" },
        protocol_compatible: { ok: false, protocol_version: null, evidence: "protocol_unverified" },
        operational: { ok: false, evidence: "runtime_unverified" },
        authorized: { ok: false, evidence: "authority_unverified" },
      }),
    };
    for (const cwd of cwds) {
      const result = await execute(["doctor", "--json"], {
        runtimeDiscovery: { env: cleanEnv(), cwd, servicePlistPath: plist },
        capabilityProbe,
      });
      reports.push(result);
    }
    const identities = reports.map(result => {
      const report = result.report as {
        database: { filename: string; applied_migrations: number; expected_migrations: number };
      };
      const st = statSync(report.database.filename);
      return {
        filename: canonicalPath(report.database.filename),
        dev: st.dev,
        ino: st.ino,
        applied: report.database.applied_migrations,
        expected: report.database.expected_migrations,
      };
    });
    expect(identities[0]).toBeDefined();
    expect(identities[1]).toEqual(identities[0]);
    expect(identities[2]).toEqual(identities[0]);
    expect(identities[0]?.applied).toBe(identities[0]?.expected);
    expect(identities[0]?.applied).toBeGreaterThan(0);
    mkdirSync(join(process.cwd(), ".omo", "evidence", "integration", "02"), { recursive: true });
    writeFileSync(
      join(process.cwd(), ".omo", "evidence", "integration", "02", "runtime-home.json"),
      `${JSON.stringify({ identities, same_dev: identities.every(item => item.dev === identities[0]?.dev), same_ino: identities.every(item => item.ino === identities[0]?.ino), same_filename: identities.every(item => item.filename === identities[0]?.filename) }, null, 2)}\n`,
    );
  }, 60_000);
});
