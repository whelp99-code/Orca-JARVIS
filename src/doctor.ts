import { execFile } from "node:child_process";
import { readdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildCapabilityMatrix, type CapabilityFact, type CapabilityMatrixV1, type CapabilityProbe } from "./capabilities.js";
import type { AuthorityDb } from "./db.js";
import { GJC_PROTOCOL_VERSION } from "./gjc.js";
import {
  buildSecondBrainReadiness,
  type SecondBrainReadinessProbe,
  type SecondBrainReadinessReportV1,
} from "./second-brain-readiness.js";
import { runtimeSecondBrainReadinessProbe } from "./second-brain-readiness-runtime.js";

export interface DoctorCheck {
  name: string;
  ok: boolean;
  actual: unknown;
  expected?: unknown;
  code?: string;
}

export interface DoctorReport {
  ok: boolean;
  checked_at: string;
  runtime: { node: string; abi: string; platform: string; arch: string };
  database: { filename: string; sqlite_version: string | null; wal_bytes: number; applied_migrations: number; expected_migrations: number };
  checks: DoctorCheck[];
  capabilities: CapabilityMatrixV1;
  second_brain: SecondBrainReadinessReportV1;
}

const expectedNodeMajor = 24;
const expectedAbi = "137";
const migrationDirectory = () => join(dirname(fileURLToPath(import.meta.url)), "../migrations");
async function safeSize(path: string): Promise<number> { try { return (await stat(path)).size; } catch { return 0; } }
function hasTable(db: AuthorityDb, table: string): boolean { return Boolean(db.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)); }

type ProbeObservation = Awaited<ReturnType<CapabilityProbe["inspect"]>>;
export type CapabilityVersionRunner = (command: "codex" | "claude") => Promise<{ stdout: string; exitCode: number }>;
const VERSION = /\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/;
const VERSION_TIMEOUT_MS = 1_500;
const VERSION_MAX_BYTES = 512;
const SHIPPED_VERSION = "0.1.0";
const closed = (evidence: string) => ({ ok: false, evidence });
const open = (evidence: string) => ({ ok: true, evidence });
const boundStdout = (value: string): string => {
  if (Buffer.byteLength(value, "utf8") <= VERSION_MAX_BYTES) return value;
  let next = value;
  while (next.length > 0 && Buffer.byteLength(next, "utf8") > VERSION_MAX_BYTES) next = next.slice(0, -1);
  return next;
};

async function defaultCapabilityVersionRunner(command: "codex" | "claude"): Promise<{ stdout: string; exitCode: number }> {
  return await new Promise(resolve => {
    execFile(command, ["--version"], {
      encoding: "utf8",
      timeout: VERSION_TIMEOUT_MS,
      maxBuffer: VERSION_MAX_BYTES,
      killSignal: "SIGKILL",
      windowsHide: true,
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", LANG: "C" },
    }, (error, stdout) => {
      const output = boundStdout(typeof stdout === "string" ? stdout : "");
      if (!error) {
        resolve({ stdout: output, exitCode: 0 });
        return;
      }
      const err = error as NodeJS.ErrnoException & { killed?: boolean; signal?: NodeJS.Signals | number };
      if (err.code === "ENOENT") {
        resolve({ stdout: "", exitCode: 127 });
        return;
      }
      if (err.killed === true || err.signal === "SIGKILL") {
        resolve({ stdout: output, exitCode: 124 });
        return;
      }
      resolve({ stdout: output, exitCode: typeof err.code === "number" ? err.code : 1 });
    });
  });
}

async function inspectExecutable(command: "codex" | "claude", runner: CapabilityVersionRunner): Promise<ProbeObservation["installed"]> {
  try {
    const result = await runner(command);
    if (result.exitCode === 124) return { ok: false, version: null, evidence: "probe_timeout" };
    if (result.exitCode === 127) return { ok: false, version: null, evidence: "missing_executable" };
    const version = result.stdout.match(VERSION)?.[0] ?? null;
    if (version === null) return { ok: false, version: null, evidence: result.exitCode === 0 ? "version_unparsed" : "missing_executable" };
    return { ok: true, version, evidence: "executable_present" };
  } catch {
    return { ok: false, version: null, evidence: "missing_executable" };
  }
}

function shipped(id: Exclude<CapabilityFact["id"], "codex" | "claude">): ProbeObservation {
  if (id === "orca_read") return { installed: { ok: true, version: null, evidence: "adapter_present" }, configured: open("library_present"), protocol_compatible: { ok: true, protocol_version: GJC_PROTOCOL_VERSION, evidence: "protocol_compatible" }, operational: open("library_present"), authorized: open("read_only") };
  if (id === "gjc") return { installed: { ok: true, version: SHIPPED_VERSION, evidence: "client_present" }, configured: open("client_present"), protocol_compatible: { ok: true, protocol_version: GJC_PROTOCOL_VERSION, evidence: "protocol_compatible" }, operational: open("client_present"), authorized: closed("authority_unverified") };
  return { installed: { ok: true, version: SHIPPED_VERSION, evidence: "adapter_present" }, configured: open("library_present"), protocol_compatible: { ok: true, protocol_version: GJC_PROTOCOL_VERSION, evidence: "protocol_compatible" }, operational: open("library_present"), authorized: closed("authority_unverified") };
}

export function runtimeCapabilityProbe(runner: CapabilityVersionRunner = defaultCapabilityVersionRunner): CapabilityProbe {
  return {
    inspect: async id => {
      if (id === "codex" || id === "claude") {
        const installed = await inspectExecutable(id, runner);
        return { installed, configured: closed("configuration_unverified"), protocol_compatible: { ok: false, protocol_version: null, evidence: "protocol_unverified" }, operational: closed("runtime_unverified"), authorized: closed("authority_unverified") };
      }
      return shipped(id);
    },
  };
}

export function passiveCapabilityProbe(): CapabilityProbe {
  return runtimeCapabilityProbe(async () => ({ stdout: "", exitCode: 127 }));
}

function unavailableCapabilities(now: Date): CapabilityMatrixV1 {
  const stages = {
    installed: { ok: false, evidence: "migrations_pending" },
    configured: { ok: false, evidence: "migrations_pending" },
    protocol_compatible: { ok: false, evidence: "migrations_pending" },
    operational: { ok: false, evidence: "migrations_pending" },
    authorized: { ok: false, evidence: "migrations_pending" },
  };
  return { schema_version: 1, checked_at: now.toISOString(), capabilities: (["codex", "claude", "orca_read", "gjc", "live_resume"] as const).map(id => ({ id, stages: { ...stages } })) };
}

export async function runDoctor(
  db: AuthorityDb,
  now = new Date(),
  probe?: CapabilityProbe,
  secondBrainProbe: SecondBrainReadinessProbe = runtimeSecondBrainReadinessProbe(),
): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  checks.push({ name: "runtime.node_major", ok: nodeMajor === expectedNodeMajor, actual: nodeMajor, expected: expectedNodeMajor, code: nodeMajor === expectedNodeMajor ? undefined : "RUNTIME_NODE_MISMATCH" });
  checks.push({ name: "runtime.node_abi", ok: process.versions.modules === expectedAbi, actual: process.versions.modules, expected: expectedAbi, code: process.versions.modules === expectedAbi ? undefined : "RUNTIME_ABI_MISMATCH" });

  let sqliteVersion: string | null = null;
  let quickCheck = "unavailable";
  try {
    sqliteVersion = String((db.db.prepare("SELECT sqlite_version() AS version").get() as { version: string }).version);
    quickCheck = String((db.db.prepare("PRAGMA quick_check").get() as { quick_check: string }).quick_check);
  } catch { quickCheck = "error"; }
  checks.push({ name: "database.quick_check", ok: quickCheck === "ok", actual: quickCheck, expected: "ok", code: quickCheck === "ok" ? undefined : "DATABASE_INTEGRITY_FAILED" });

  const expected = (await readdir(migrationDirectory())).filter(file => file.endsWith(".sql")).length;
  const applied = hasTable(db, "schema_migrations") ? Number((db.db.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get() as { count: number }).count) : 0;
  checks.push({ name: "database.migration_count", ok: applied === expected, actual: applied, expected, code: applied === expected ? undefined : "MIGRATIONS_PENDING" });
  try { await db.assertMigrationsReady(); checks.push({ name: "database.migration_checksums", ok: true, actual: "verified" }); }
  catch (error) { checks.push({ name: "database.migration_checksums", ok: false, actual: error instanceof Error ? error.message : "unknown", expected: "verified", code: "MIGRATION_CHECKSUM_FAILED" }); }

  if (hasTable(db, "gjc_runtime_status")) {
    const runtime = db.db.prepare("SELECT last_heartbeat_at,last_error_code FROM gjc_runtime_status WHERE id=1").get() as { last_heartbeat_at?: string; last_error_code?: string | null } | undefined;
    if (runtime) {
      const heartbeatAge = runtime.last_heartbeat_at ? Math.max(0, now.getTime() - Date.parse(runtime.last_heartbeat_at)) : null;
      const heartbeatOk = heartbeatAge !== null && Number.isFinite(heartbeatAge) && heartbeatAge <= 60_000;
      checks.push({ name: "service.last_error", ok: !runtime.last_error_code, actual: runtime.last_error_code ?? null, expected: null, code: runtime.last_error_code ? "SERVICE_LAST_ERROR" : undefined });
      checks.push({ name: "service.heartbeat_age_ms", ok: heartbeatOk, actual: heartbeatAge, expected: "<=60000", code: heartbeatOk ? undefined : "SERVICE_HEARTBEAT_STALE" });
    }
  }

  if (hasTable(db, "live_supervisor_reports") && hasTable(db, "live_supervisor_report_receipts")) {
    const pending = Number((db.db.prepare("SELECT COUNT(*) AS count FROM live_supervisor_reports r LEFT JOIN live_supervisor_report_receipts a ON a.report_id=r.report_id WHERE a.report_id IS NULL").get() as { count: number }).count);
    checks.push({ name: "supervisor.pending_reports", ok: pending === 0, actual: pending, expected: 0, code: pending === 0 ? undefined : "REPORT_BACKLOG" });
  }

  const migrationsReady = hasTable(db, "gjc_runtime_config")
    && hasTable(db, "gjc_runtime_config_audit")
    && hasTable(db, "live_supervisor_live_resume_config")
    && hasTable(db, "live_supervisor_live_resume_config_audit")
    && hasTable(db, "live_supervisor_bindings");
  const capabilities = migrationsReady
    ? await buildCapabilityMatrix(db, probe ?? runtimeCapabilityProbe(), now)
    : unavailableCapabilities(now);
  const secondBrain = await buildSecondBrainReadiness(secondBrainProbe, now);
  const report: DoctorReport = {
    ok: checks.every(check => check.ok),
    checked_at: now.toISOString(),
    runtime: { node: process.version, abi: process.versions.modules, platform: process.platform, arch: process.arch },
    database: { filename: db.filename, sqlite_version: sqliteVersion, wal_bytes: await safeSize(`${db.filename}-wal`), applied_migrations: applied, expected_migrations: expected },
    checks,
    capabilities,
    second_brain: secondBrain,
  };
  return report;
}
