import { readdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildCapabilityMatrix, type CapabilityMatrixV1, type CapabilityProbe } from "./capabilities.js";
import type { AuthorityDb } from "./db.js";
import { buildSecondBrainReadiness, type SecondBrainReadinessProbe, type SecondBrainReadinessReportV1 } from "./second-brain-readiness.js";
import { runtimeSecondBrainReadinessProbe } from "./second-brain-readiness-runtime.js";
import { runtimeCapabilityProbe } from "./doctor-capability-probe.js";
export { passiveCapabilityProbe, runtimeCapabilityProbe, type CapabilityVersionRunner } from "./doctor-capability-probe.js";
export interface DoctorCheck {
	name: string;
	ok: boolean;
	actual: unknown;
	expected?: unknown;
	code?: string;
}
export interface DoctorReport {
	ok: boolean;
	checked_at: string | null;
	runtime: { node: string; abi: string; platform: string; arch: string };
	database: { filename: string; sqlite_version: string | null; wal_bytes: number; applied_migrations: number; expected_migrations: number };
	checks: DoctorCheck[];
	capabilities: CapabilityMatrixV1;
	second_brain: SecondBrainReadinessReportV1;
}
const expectedNodeMajor = 24;
const expectedAbi = "137";
const PENDING_REPORT_SQL = "SELECT COUNT(*) AS count FROM live_supervisor_reports r "
  + "LEFT JOIN live_supervisor_report_receipts a ON a.report_id=r.report_id WHERE a.report_id IS NULL";
const migrationDirectory = () => join(dirname(fileURLToPath(import.meta.url)), "../migrations");
async function safeSize(path: string): Promise<number> {
	try {
		return (await stat(path)).size;
	} catch {
		return 0;
	}
}
function hasTable(db: AuthorityDb, table: string): boolean {
	return Boolean(db.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table));
}
function finiteOrNull(value: number): number | null {
	return Number.isFinite(value) ? value : null;
}
function unavailableCapabilities(now: Date): CapabilityMatrixV1 {
	const stages = {
		installed: { ok: false, evidence: "migrations_pending" },
		configured: { ok: false, evidence: "migrations_pending" },
		protocol_compatible: { ok: false, evidence: "migrations_pending" },
		operational: { ok: false, evidence: "migrations_pending" },
		authorized: { ok: false, evidence: "migrations_pending" },
	};
	const validClock = Number.isFinite(now.getTime());
	const error: CapabilityMatrixV1["error"] = { code: "CAPABILITY_CLOCK_INVALID" };
	return {
		schema_version: 1,
		checked_at: validClock ? now.toISOString() : null,
		capabilities: (["codex", "claude", "orca_read", "gjc", "live_resume"] as const).map((id) => ({ id, stages: { ...stages } })),
		...(validClock ? {} : { error }),
	};
}
export async function runDoctor(
	db: AuthorityDb,
	now = new Date(),
	probe?: CapabilityProbe,
	secondBrainProbe: SecondBrainReadinessProbe = runtimeSecondBrainReadinessProbe(),
): Promise<DoctorReport> {
	const checks: DoctorCheck[] = [];
	const validClock = Number.isFinite(now.getTime());
	if (!validClock) {
		checks.push({
			name: "runtime.clock",
			ok: false,
			actual: null,
			expected: "finite",
			code: "SECOND_BRAIN_CLOCK_INVALID",
		});
	}
	const nodeMajor = Number(process.versions.node.split(".")[0]);
	checks.push({
		name: "runtime.node_major",
		ok: nodeMajor === expectedNodeMajor,
		actual: nodeMajor,
		expected: expectedNodeMajor,
		code: nodeMajor === expectedNodeMajor ? undefined : "RUNTIME_NODE_MISMATCH",
	});
	checks.push({
		name: "runtime.node_abi",
		ok: process.versions.modules === expectedAbi,
		actual: process.versions.modules,
		expected: expectedAbi,
		code: process.versions.modules === expectedAbi ? undefined : "RUNTIME_ABI_MISMATCH",
	});
	let sqliteVersion: string | null = null;
	let quickCheck = "unavailable";
	try {
		sqliteVersion = String((db.db.prepare("SELECT sqlite_version() AS version").get() as { version: string }).version);
		quickCheck = String((db.db.prepare("PRAGMA quick_check").get() as { quick_check: string }).quick_check);
	} catch {
		quickCheck = "error";
	}
	checks.push({
		name: "database.quick_check",
		ok: quickCheck === "ok",
		actual: quickCheck,
		expected: "ok",
		code: quickCheck === "ok" ? undefined : "DATABASE_INTEGRITY_FAILED",
	});
	const files = (await readdir(migrationDirectory())).filter((file) => file.endsWith(".sql"));
	const expected = files.length;
	const appliedIds = new Set(
		hasTable(db, "schema_migrations")
			? (db.db.prepare("SELECT id FROM schema_migrations").all() as Array<{ id: string }>).map((row) => row.id)
			: [],
	);
	const applied = files.filter((file) => appliedIds.has(file)).length;
	checks.push({
		name: "database.migration_count",
		ok: applied === expected,
		actual: applied,
		expected,
		code: applied === expected ? undefined : "MIGRATIONS_PENDING",
	});
	try {
		await db.assertMigrationsReady();
		checks.push({ name: "database.migration_checksums", ok: true, actual: "verified" });
	} catch (error) {
		checks.push({
			name: "database.migration_checksums",
			ok: false,
			actual: error instanceof Error ? error.message : "unknown",
			expected: "verified",
			code: "MIGRATION_CHECKSUM_FAILED",
		});
	}
	if (hasTable(db, "gjc_runtime_status")) {
		const runtime = db.db.prepare("SELECT last_heartbeat_at,last_error_code FROM gjc_runtime_status WHERE id=1").get() as
			| { last_heartbeat_at?: string; last_error_code?: string | null }
			| undefined;
		if (runtime) {
			const heartbeatAge = validClock && runtime.last_heartbeat_at
				? finiteOrNull(Math.max(0, now.getTime() - Date.parse(runtime.last_heartbeat_at)))
				: null;
			const heartbeatOk = heartbeatAge !== null && heartbeatAge <= 60_000;
			checks.push({
				name: "service.last_error",
				ok: !runtime.last_error_code,
				actual: runtime.last_error_code ?? null,
				expected: null,
				code: runtime.last_error_code ? "SERVICE_LAST_ERROR" : undefined,
			});
			checks.push({
				name: "service.heartbeat_age_ms",
				ok: heartbeatOk,
				actual: heartbeatAge,
				expected: "<=60000",
				code: heartbeatOk ? undefined : validClock ? "SERVICE_HEARTBEAT_STALE" : "SECOND_BRAIN_CLOCK_INVALID",
			});
		}
	}
	if (hasTable(db, "live_supervisor_reports") && hasTable(db, "live_supervisor_report_receipts")) {
		const pending = Number(
			(
				db.db
					.prepare(
						PENDING_REPORT_SQL,
					)
					.get() as { count: number }
			).count,
		);
		checks.push({
			name: "supervisor.pending_reports",
			ok: pending === 0,
			actual: pending,
			expected: 0,
			code: pending === 0 ? undefined : "REPORT_BACKLOG",
		});
	}
	const migrationsReady =
		hasTable(db, "gjc_runtime_config") &&
		hasTable(db, "gjc_runtime_config_audit") &&
		hasTable(db, "live_supervisor_live_resume_config") &&
		hasTable(db, "live_supervisor_live_resume_config_audit") &&
		hasTable(db, "live_supervisor_bindings");
	const capabilities = migrationsReady
		? await buildCapabilityMatrix(db, probe ?? runtimeCapabilityProbe(), now)
		: unavailableCapabilities(now);
	const secondBrain = await buildSecondBrainReadiness(secondBrainProbe, now);
	const report: DoctorReport = {
		ok: checks.every((check) => check.ok),
		checked_at: validClock ? now.toISOString() : null,
		runtime: { node: process.version, abi: process.versions.modules, platform: process.platform, arch: process.arch },
		database: {
			filename: db.filename,
			sqlite_version: sqliteVersion,
			wal_bytes: await safeSize(`${db.filename}-wal`),
			applied_migrations: applied,
			expected_migrations: expected,
		},
		checks,
		capabilities,
		second_brain: secondBrain,
	};
	return report;
}
