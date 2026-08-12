import { readdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AuthorityDb } from "./db.js";

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
}

const expectedNodeMajor = 24;
const expectedAbi = "137";
const migrationDirectory = () => join(dirname(fileURLToPath(import.meta.url)), "../migrations");
async function safeSize(path: string): Promise<number> { try { return (await stat(path)).size; } catch { return 0; } }
function hasTable(db: AuthorityDb, table: string): boolean { return Boolean(db.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)); }

export async function runDoctor(db: AuthorityDb, now = new Date()): Promise<DoctorReport> {
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

  const report: DoctorReport = {
    ok: checks.every(check => check.ok),
    checked_at: now.toISOString(),
    runtime: { node: process.version, abi: process.versions.modules, platform: process.platform, arch: process.arch },
    database: { filename: db.filename, sqlite_version: sqliteVersion, wal_bytes: await safeSize(`${db.filename}-wal`), applied_migrations: applied, expected_migrations: expected },
    checks,
  };
  return report;
}
