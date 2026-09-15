import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { openUnderSwapAdmission } from "./authority-database-swap-barrier.js";
import { migrationVectorHash } from "./backend-build-files.js";
import type { CapabilityProbe } from "./capabilities.js";
import {
  DASHBOARD_HEALTH_MAX_BYTES,
  DASHBOARD_HEALTH_TIMEOUT_MS,
  DASHBOARD_HEALTH_URL,
} from "./dashboard-runtime-config.js";
import { AuthorityDb } from "./db.js";
import { runDoctor } from "./doctor.js";
import { readCycleCursor } from "./personal-os-cycle-channel.js";
import { applyCycleId } from "./personal-os-cycle-cursor.js";
import type { SecondBrainReadinessProbe } from "./second-brain-readiness.js";
import { attestedSecondBrainHandshake } from "./second-brain-readiness-handshake.js";
import {
  SECOND_BRAIN_CONTRACT_PROFILE,
  SECOND_BRAIN_PROTOCOL_VERSION,
  SecondBrainTransportError,
  createSecondBrainTransport,
} from "./second-brain-transport.js";

/** The nine pre/post-activation health gates named by docs/personal-os/release.md, in that order. */
export const RELEASE_GATE_NAMES = [
  "migration-vector",
  "quick-check",
  "foreign-key-check",
  "doctor",
  "status",
  "dashboard-health",
  "mcp-handshake",
  "scheduler-cursor",
  "uncertain-outbox",
] as const;
export type ReleaseGateName = (typeof RELEASE_GATE_NAMES)[number];

export type ReleaseGate = {
  readonly name: ReleaseGateName;
  readonly ok: boolean;
  readonly actual: unknown;
  readonly code?: string;
};

export type ReleaseGateReport = {
  readonly schema_version: 1;
  readonly ok: boolean;
  readonly checked_at: string | null;
  readonly database: string;
  readonly gates: readonly ReleaseGate[];
  readonly failed: readonly string[];
};

export type ReleaseGateOptions = {
  readonly dbPath: string;
  readonly now?: Date;
  readonly dashboardUrl?: string;
  readonly dashboardTimeoutMs?: number;
  readonly capabilityProbe?: CapabilityProbe;
  readonly secondBrainProbe?: SecondBrainReadinessProbe;
  readonly launcherPath?: string;
  readonly configPath?: string;
  readonly contractPath?: string;
};

function gate(name: ReleaseGateName, ok: boolean, actual: unknown, code?: string): ReleaseGate {
  return code === undefined ? { name, ok, actual } : { name, ok, actual, code };
}

/** Every database gate answers from its own read-only connection; none of them may write. */
function readOnly<T>(dbPath: string, fn: (db: Database.Database) => T): T {
  const db = openUnderSwapAdmission(dbPath,
    () => new Database(dbPath, { readonly: true, fileMustExist: true }));
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

function hasTable(db: Database.Database, table: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table));
}

function migrationDirectory(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "../migrations");
}

export type MigrationEntryObservation = { readonly id: string; readonly sha256: string };

export async function shippedMigrationEntries(
  directory = migrationDirectory(),
): Promise<readonly MigrationEntryObservation[]> {
  const files = (await readdir(directory)).filter(file => file.endsWith(".sql")).sort();
  return Promise.all(files.map(async id => ({
    id,
    sha256: createHash("sha256").update(await readFile(join(directory, id))).digest("hex"),
  })));
}

/** PRAGMA quick_check on a read-only open; anything but `ok` fails the gate. */
export function quickCheckGate(dbPath: string): ReleaseGate {
  try {
    const value = readOnly(dbPath, db => db.pragma("quick_check", { simple: true }));
    const check = typeof value === "string" ? value : "fail";
    return gate("quick-check", check === "ok", { quick_check: check },
      check === "ok" ? undefined : "DATABASE_INTEGRITY_FAILED");
  } catch {
    return gate("quick-check", false, { quick_check: "unavailable" }, "RELEASE_GATE_DATABASE_UNAVAILABLE");
  }
}

/** PRAGMA foreign_key_check on a read-only open; any returned row fails the gate. */
export function foreignKeyCheckGate(dbPath: string): ReleaseGate {
  try {
    const rows = readOnly(dbPath, db => db.prepare("PRAGMA foreign_key_check").all() as unknown[]);
    return gate("foreign-key-check", rows.length === 0,
      { violations: rows.length, first_violations: rows.slice(0, 8) },
      rows.length === 0 ? undefined : "DATABASE_FOREIGN_KEY_VIOLATION");
  } catch {
    return gate("foreign-key-check", false, { violations: null }, "RELEASE_GATE_DATABASE_UNAVAILABLE");
  }
}

/** The exact applied migration vector, compared entry by entry against the shipped migrations. */
export async function migrationVectorGate(dbPath: string): Promise<ReleaseGate> {
  let expected: readonly MigrationEntryObservation[];
  try {
    expected = await shippedMigrationEntries();
  } catch {
    return gate("migration-vector", false, { expected: null }, "RELEASE_GATE_MIGRATIONS_UNREADABLE");
  }
  try {
    const applied = readOnly(dbPath, db => hasTable(db, "schema_migrations")
      ? db.prepare("SELECT id, checksum AS sha256 FROM schema_migrations ORDER BY id").all() as MigrationEntryObservation[]
      : []);
    const appliedById = new Map(applied.map(entry => [entry.id, entry.sha256]));
    const pending = expected.filter(entry => !appliedById.has(entry.id)).map(entry => entry.id);
    const mismatched = expected
      .filter(entry => appliedById.has(entry.id) && appliedById.get(entry.id) !== entry.sha256)
      .map(entry => entry.id);
    const expectedIds = new Set(expected.map(entry => entry.id));
    const unknown = applied.filter(entry => !expectedIds.has(entry.id)).map(entry => entry.id);
    const ok = pending.length === 0 && mismatched.length === 0 && unknown.length === 0;
    return gate("migration-vector", ok, {
      expected_digest: migrationVectorHash(expected),
      applied_digest: migrationVectorHash(applied),
      expected_migrations: expected.length,
      applied_migrations: applied.length,
      pending_migrations: pending,
      checksum_mismatched: mismatched,
      unsupported_applied: unknown,
    }, ok ? undefined
      : mismatched.length > 0 ? "MIGRATION_CHECKSUM_MISMATCH"
      : unknown.length > 0 ? "MIGRATION_VERSION_UNSUPPORTED"
      : "MIGRATIONS_PENDING");
  } catch {
    return gate("migration-vector", false, { applied: null }, "RELEASE_GATE_DATABASE_UNAVAILABLE");
  }
}

/** Queued memory writes whose delivery is unresolved; activation may not run over an uncertain outbox. */
export function uncertainOutboxGate(dbPath: string): ReleaseGate {
  try {
    const counts = readOnly(dbPath, db => {
      const count = (table: string): number => hasTable(db, table)
        ? Number(db.prepare(`SELECT COUNT(*) FROM ${table} WHERE state='uncertain'`).pluck().get())
        : 0;
      return { memory_outbox: count("memory_outbox"), daily_loop_runs: count("daily_loop_runs") };
    });
    const total = counts.memory_outbox + counts.daily_loop_runs;
    return gate("uncertain-outbox", total === 0, { uncertain: total, ...counts },
      total === 0 ? undefined : "RELEASE_GATE_UNCERTAIN_OUTBOX");
  } catch {
    return gate("uncertain-outbox", false, { uncertain: null }, "RELEASE_GATE_DATABASE_UNAVAILABLE");
  }
}

function nextCycleId(lastCompleted: number): number | null {
  const result = applyCycleId(lastCompleted, lastCompleted + 1);
  return result.kind === "applied" ? result.id : null;
}

/**
 * The persisted personal-OS cycle cursor and its consistency with daily_loop_runs. The channel
 * advances last_completed and applied_count together from zero, so they must be equal, and the
 * cursor may never sit behind the completed daily loop runs it accounts for.
 */
export function schedulerCursorGate(dbPath: string): ReleaseGate {
  try {
    return readOnly(dbPath, db => {
      if (!hasTable(db, "personal_os_cycle_cursor")) {
        return gate("scheduler-cursor", false, { cursor: null }, "RELEASE_GATE_SCHEDULER_CURSOR_ABSENT");
      }
      const cursor = readCycleCursor(db);
      const completed = hasTable(db, "daily_loop_runs")
        ? Number(db.prepare("SELECT COUNT(*) FROM daily_loop_runs WHERE state='completed'").pluck().get())
        : 0;
      const monotonic = cursor.applied_count === cursor.last_completed;
      const notBehind = cursor.last_completed >= completed;
      const ok = monotonic && notBehind;
      return gate("scheduler-cursor", ok, {
        last_completed: cursor.last_completed,
        applied_count: cursor.applied_count,
        next_cycle_id: nextCycleId(cursor.last_completed),
        completed_daily_loop_runs: completed,
        cursor_monotonic: monotonic,
        not_behind_daily_loop: notBehind,
      }, ok ? undefined : "RELEASE_GATE_SCHEDULER_CURSOR_INCONSISTENT");
    });
  } catch {
    return gate("scheduler-cursor", false, { cursor: null }, "RELEASE_GATE_SCHEDULER_CURSOR_UNREADABLE");
  }
}

async function boundedBody(response: Response, maxBytes: number): Promise<string | undefined> {
  const body = response.body;
  if (body === null) return "";
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      total += value.byteLength;
      if (total > maxBytes) return undefined;
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return Buffer.concat(chunks.map(chunk => Buffer.from(chunk))).toString("utf8");
}

/** A bounded-timeout GET of the configured dashboard health route. Fails closed on any refusal. */
export async function dashboardHealthGate(input: {
  readonly url?: string;
  readonly timeoutMs?: number;
} = {}): Promise<ReleaseGate> {
  const url = input.url ?? DASHBOARD_HEALTH_URL;
  const timeoutMs = input.timeoutMs ?? DASHBOARD_HEALTH_TIMEOUT_MS;
  try {
    const response = await fetch(url, {
      method: "GET",
      redirect: "error",
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (response.status !== 200) {
      return gate("dashboard-health", false, { url, status: response.status },
        "RELEASE_GATE_DASHBOARD_UNHEALTHY");
    }
    const text = await boundedBody(response, DASHBOARD_HEALTH_MAX_BYTES);
    if (text === undefined) {
      return gate("dashboard-health", false, { url, status: 200, body: "oversize" },
        "RELEASE_GATE_DASHBOARD_OVERSIZE");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return gate("dashboard-health", false, { url, status: 200, body: "malformed" },
        "RELEASE_GATE_DASHBOARD_MALFORMED");
    }
    const record = typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined;
    const status = record?.["status"];
    const authority = record?.["authority"];
    const ok = status === "ok" && authority === "ready";
    return gate("dashboard-health", ok, { url, status: 200, health_status: status ?? null, authority: authority ?? null },
      ok ? undefined : "RELEASE_GATE_DASHBOARD_UNHEALTHY");
  } catch (error) {
    const timeout = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
    return gate("dashboard-health", false, { url, status: null },
      timeout ? "RELEASE_GATE_DASHBOARD_TIMEOUT" : "RELEASE_GATE_DASHBOARD_UNREACHABLE");
  }
}

/**
 * A real handshake over the Second Brain stdio transport contract. The launcher and config come
 * from JARVIS_SECOND_BRAIN_LAUNCHER/JARVIS_SECOND_BRAIN_CONFIG when set, so an isolated provider
 * can be probed without touching the deployed installation. Any refusal fails the gate closed.
 */
export async function mcpHandshakeGate(input: {
  readonly launcherPath?: string;
  readonly configPath?: string;
  readonly contractPath?: string;
} = {}): Promise<ReleaseGate> {
  const launcherPath = input.launcherPath ?? process.env["JARVIS_SECOND_BRAIN_LAUNCHER"];
  const configPath = input.configPath ?? process.env["JARVIS_SECOND_BRAIN_CONFIG"];
  const observed = { launcher_configured: launcherPath !== undefined, contract_profile: SECOND_BRAIN_CONTRACT_PROFILE };
  let transport: ReturnType<typeof createSecondBrainTransport>;
  try {
    transport = createSecondBrainTransport({
      launcherPath, configPath, contractPath: input.contractPath, safeReadRetries: 0,
    });
  } catch (error) {
    return gate("mcp-handshake", false, { ...observed, protocol_version: null },
      error instanceof SecondBrainTransportError ? error.code : "SECOND_BRAIN_HANDSHAKE_FAILED");
  }
  let result: ReleaseGate;
  try {
    await transport.restart();
    const facts = attestedSecondBrainHandshake(transport.diagnostics());
    if (facts === undefined) {
      result = gate("mcp-handshake", false, { ...observed, protocol_version: null }, "SECOND_BRAIN_HANDSHAKE_MALFORMED");
    } else {
      const ok = facts.protocol_version === SECOND_BRAIN_PROTOCOL_VERSION;
      result = gate("mcp-handshake", ok, {
        ...observed,
        protocol_version: facts.protocol_version,
        expected_protocol_version: SECOND_BRAIN_PROTOCOL_VERSION,
        server_name: facts.server_name,
        server_version: facts.server_version,
        tools: facts.tools,
      }, ok ? undefined : "SECOND_BRAIN_VERSION_MISMATCH");
    }
  } catch (error) {
    result = gate("mcp-handshake", false, { ...observed, protocol_version: null },
      error instanceof SecondBrainTransportError ? error.code : "SECOND_BRAIN_HANDSHAKE_FAILED");
  }
  try {
    await transport.close();
  } catch {
    return gate("mcp-handshake", false, { ...observed, protocol_version: null }, "SECOND_BRAIN_HANDSHAKE_FAILED");
  }
  return result;
}

async function doctorGate(options: ReleaseGateOptions, now: Date): Promise<ReleaseGate> {
  const db = new AuthorityDb(options.dbPath, undefined, { readonly: true, fileMustExist: true });
  try {
    const report = await runDoctor(db, now, options.capabilityProbe, options.secondBrainProbe);
    return gate("doctor", report.ok, {
      failed_checks: report.checks.filter(check => !check.ok).map(check => ({ name: check.name, code: check.code })),
      checks: report.checks.length,
    }, report.ok ? undefined : "RELEASE_GATE_DOCTOR_FAILED");
  } catch {
    return gate("doctor", false, { failed_checks: null }, "RELEASE_GATE_DOCTOR_UNAVAILABLE");
  } finally {
    db.close();
  }
}

function statusGate(dbPath: string): ReleaseGate {
  const db = new AuthorityDb(dbPath, undefined, { readonly: true, fileMustExist: true });
  try {
    const status = db.status();
    const pending = Number(status["pending_outbox"] ?? 0);
    return gate("status", pending === 0, { states: status["states"], pending_outbox: pending },
      pending === 0 ? undefined : "RELEASE_GATE_STATUS_PENDING");
  } catch {
    return gate("status", false, { states: null }, "RELEASE_GATE_STATUS_UNAVAILABLE");
  } finally {
    db.close();
  }
}

/** Runs all nine gates. The aggregate is not ok unless every gate is ok. */
export async function runReleaseGates(options: ReleaseGateOptions): Promise<ReleaseGateReport> {
  const now = options.now ?? new Date();
  const gates: ReleaseGate[] = [
    await migrationVectorGate(options.dbPath),
    quickCheckGate(options.dbPath),
    foreignKeyCheckGate(options.dbPath),
    await doctorGate(options, now),
    statusGate(options.dbPath),
    await dashboardHealthGate({ url: options.dashboardUrl, timeoutMs: options.dashboardTimeoutMs }),
    await mcpHandshakeGate({
      launcherPath: options.launcherPath, configPath: options.configPath, contractPath: options.contractPath,
    }),
    schedulerCursorGate(options.dbPath),
    uncertainOutboxGate(options.dbPath),
  ];
  const failed = gates.filter(item => !item.ok).map(item => item.name);
  return {
    schema_version: 1,
    ok: failed.length === 0,
    checked_at: Number.isFinite(now.getTime()) ? now.toISOString() : null,
    database: options.dbPath,
    gates,
    failed,
  };
}
