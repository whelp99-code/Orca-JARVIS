import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { join } from "node:path";
import { AuthorityDb } from "./db.js";
import { createDashboardServer } from "./dashboard/server.js";
import { passiveSecondBrainReadinessProbe } from "./second-brain-readiness.js";
import { quickCheck } from "./personal-os-rehearsal-database.js";
import {
  runReleaseGates,
  schedulerCursorGate,
  uncertainOutboxGate,
  type ReleaseGate,
} from "./release-health-gates.js";

export type DoctorRun = {
  readonly ok: boolean;
  readonly status: number | null;
  readonly report: unknown;
};

function get(url: string): Promise<{ readonly status: number; readonly body: string }> {
  return new Promise((resolve, reject) => {
    const outgoing = request(url, response => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => resolve({
        status: response.statusCode ?? 0,
        body: Buffer.concat(chunks).toString("utf8"),
      }));
    });
    outgoing.on("error", reject);
    outgoing.end();
  });
}

export function runPackagedDoctor(input: {
  readonly cliPath: string;
  readonly dbPath: string;
  readonly launcher: string;
  readonly configPath: string;
}): DoctorRun {
  const result = spawnSync(process.execPath, [input.cliPath, "doctor", "--json", "--db", input.dbPath], {
    encoding: "utf8",
    env: {
      ...process.env,
      JARVIS_SECOND_BRAIN_LAUNCHER: input.launcher,
      JARVIS_SECOND_BRAIN_CONFIG: input.configPath,
    },
  });
  let report: unknown = null;
  try { report = JSON.parse(result.stdout); } catch { report = null; }
  const record = typeof report === "object" && report !== null ? report as Record<string, unknown> : undefined;
  return { ok: result.status === 0 && record?.["ok"] === true, status: result.status, report };
}

export async function runIsolatedGates(input: {
  readonly dbPath: string;
  readonly staticRoot: string;
  readonly launcher: string;
  readonly configPath: string;
}): Promise<{
  readonly health: { readonly ok: boolean; readonly url: string; readonly status: number; readonly authority: unknown };
  readonly gates: { readonly ok: boolean; readonly failed: readonly string[]; readonly gates: unknown };
}> {
  mkdirSync(input.staticRoot, { recursive: true });
  writeFileSync(join(input.staticRoot, "index.html"), "<!doctype html><title>rehearsal</title>\n");
  const db = new AuthorityDb(input.dbPath, undefined, { readonly: true, fileMustExist: true });
  const server = createDashboardServer({
    db, staticRoot: input.staticRoot, host: "127.0.0.1", port: 0,
    secondBrainProbe: passiveSecondBrainReadinessProbe(),
  });
  try {
    const url = `http://${server.address.host}:${server.address.port}/api/v1/health`;
    const response = await get(url);
    const parsed: unknown = JSON.parse(response.body);
    const body = typeof parsed === "object" && parsed !== null ? parsed as Record<string, unknown> : {};
    const health = {
      ok: response.status === 200 && body["status"] === "ok" && body["authority"] === "ready",
      url, status: response.status, authority: body["authority"] ?? null,
    };
    const report = await runReleaseGates({
      dbPath: input.dbPath, dashboardUrl: url, launcherPath: input.launcher,
      configPath: input.configPath, phase: "post-activation",
    });
    return { health, gates: { ok: report.ok, failed: report.failed, gates: report.gates } };
  } finally {
    server.close();
    db.close();
  }
}

export function leaseGates(dbPath: string): {
  readonly quick_check: string;
  readonly scheduler: ReleaseGate;
  readonly uncertain: ReleaseGate;
} {
  return {
    quick_check: quickCheck(dbPath),
    scheduler: schedulerCursorGate(dbPath, { controlChannelConfigured: false }),
    uncertain: uncertainOutboxGate(dbPath),
  };
}
