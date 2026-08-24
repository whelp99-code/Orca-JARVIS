import { homedir } from "node:os";
import { mkdirSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { execute } from "../../src/cli.js";
import { defaultJarvisLaunchAgentPath } from "../../src/orca-env.js";

const LIVE_DB = "/Volumes/DevSpace/Orca-JARVIS/.jarvis-runtime/jarvis.sqlite";

function cleanEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.JARVIS_RUNTIME_HOME;
  delete env.JARVIS_DB;
  delete env.JARVIS_TEST_RUNTIME_HOME;
  return env;
}

const probe = {
  inspect: async () => ({
    installed: { ok: false, version: null, evidence: "missing_executable" },
    configured: { ok: false, evidence: "configuration_unverified" },
    protocol_compatible: { ok: false, protocol_version: null, evidence: "protocol_unverified" },
    operational: { ok: false, evidence: "runtime_unverified" },
    authorized: { ok: false, evidence: "authority_unverified" },
  }),
};

describe("live local doctor identity", () => {
  it("resolves the installed LOCAL authority DB from three unrelated cwd values without SSH", async () => {
    const plist = defaultJarvisLaunchAgentPath(homedir());
    const cwds = [0, 1, 2].map(index => mkdtempSync(join(tmpdir(), `jarvis-live-cwd-${index}-`)));
    const reports = [];
    for (const cwd of cwds) {
      const result = await execute(["doctor", "--json"], {
        runtimeDiscovery: { env: cleanEnv(), cwd, servicePlistPath: plist },
        capabilityProbe: probe,
      });
      const database = (result.report as { database: { filename: string; applied_migrations: number; expected_migrations: number; source?: string } }).database;
      const st = statSync(database.filename);
      reports.push({
        cwd,
        filename: database.filename,
        source: database.source,
        applied: database.applied_migrations,
        expected: database.expected_migrations,
        dev: st.dev,
        ino: st.ino,
      });
    }
    expect(reports[0]?.filename).toBe(LIVE_DB);
    expect(reports[0]?.source).toBe("service");
    expect(reports[1]).toMatchObject({ filename: reports[0]?.filename, dev: reports[0]?.dev, ino: reports[0]?.ino, applied: reports[0]?.applied });
    expect(reports[2]).toMatchObject({ filename: reports[0]?.filename, dev: reports[0]?.dev, ino: reports[0]?.ino, applied: reports[0]?.applied });
    mkdirSync(join(process.cwd(), ".omo/evidence/integration/02"), { recursive: true });
    writeFileSync(join(process.cwd(), ".omo/evidence/integration/02/live-local-doctor.json"), `${JSON.stringify({
      plist,
      liveDb: LIVE_DB,
      ssh: false,
      reports,
    }, null, 2)}\n`);
  }, 60_000);
});
