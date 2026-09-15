import Database from "better-sqlite3";
import { openUnderSwapAdmission } from "./authority-database-swap-barrier.js";
import type { CapabilityProbe } from "./capabilities.js";
import type { SecondBrainReadinessProbe } from "./second-brain-readiness.js";

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
  /**
   * A gate that has nothing to judge on this deployment passes and says so, so an operator reads
   * the reason out of the report instead of inferring it from a pass.
   */
  readonly not_applicable?: true;
};

/**
 * Which side of the service restart the gates are being run on. `jm-jarvis.service` migrates the
 * database in ExecStartPre, so before activation a pending-migration vector is the expected state
 * and is accepted only against a rehearsal receipt; after activation nothing may still be pending.
 */
export const RELEASE_PHASES = ["pre-activation", "post-activation"] as const;
export type ReleasePhase = (typeof RELEASE_PHASES)[number];
export const DEFAULT_RELEASE_PHASE: ReleasePhase = "post-activation";

export type ReleaseGateReport = {
  readonly schema_version: 1;
  readonly ok: boolean;
  readonly phase: ReleasePhase;
  readonly checked_at: string | null;
  readonly database: string;
  readonly gates: readonly ReleaseGate[];
  readonly failed: readonly string[];
};

export type ReleaseGateOptions = {
  readonly dbPath: string;
  readonly phase?: ReleasePhase;
  readonly rehearsalReceiptPath?: string;
  readonly now?: Date;
  readonly dashboardUrl?: string;
  readonly dashboardTimeoutMs?: number;
  readonly capabilityProbe?: CapabilityProbe;
  readonly secondBrainProbe?: SecondBrainReadinessProbe;
  readonly launcherPath?: string;
  readonly configPath?: string;
  readonly contractPath?: string;
};

export function gate(name: ReleaseGateName, ok: boolean, actual: unknown, code?: string): ReleaseGate {
  return code === undefined ? { name, ok, actual } : { name, ok, actual, code };
}

/** A pass that carries why there was nothing to judge; it never hides a reading that did happen. */
export function notApplicable(name: ReleaseGateName, reason: string, actual: object): ReleaseGate {
  return { name, ok: true, actual: { ...actual, applicable: false, reason }, not_applicable: true };
}

/** Every database gate answers from its own read-only connection; none of them may write. */
export function readOnly<T>(dbPath: string, fn: (db: Database.Database) => T): T {
  const db = openUnderSwapAdmission(dbPath,
    () => new Database(dbPath, { readonly: true, fileMustExist: true }));
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

export function hasTable(db: Database.Database, table: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table));
}

/** One health check as doctor reports it, read structurally so the contract loads no doctor. */
export type HealthCheckFinding = {
  readonly name: string;
  readonly ok: boolean;
  readonly actual: unknown;
  readonly expected?: unknown;
  readonly code?: string;
};

/**
 * Whether one failed doctor check is nothing but the pending-but-rehearsed migration vector seen
 * again through doctor's own reading of the same database.
 *
 * `database.migration_count` qualifies when its shortfall is exactly the pending set, so a count
 * short for any other reason still fails. `database.migration_checksums` qualifies when the
 * readiness assertion named one of those pending migrations: it walks the shipped migrations in
 * order and reports the first unapplied one, and the migration-vector gate has already compared
 * every applied migration's checksum against the shipped bytes, so a genuine mismatch or an
 * unsupported history never reaches here. A readiness refusal naming no pending migration —
 * recovery residue, an absent journal — is not explained by the rehearsal and still fails.
 */
export function deferredToRehearsal(check: HealthCheckFinding, pending: readonly string[]): boolean {
  if (check.name === "database.migration_count") {
    return check.code === "MIGRATIONS_PENDING"
      && typeof check.actual === "number" && typeof check.expected === "number"
      && check.expected - check.actual === pending.length;
  }
  if (check.name === "database.migration_checksums") {
    return check.code === "MIGRATION_CHECKSUM_FAILED"
      && typeof check.actual === "string" && pending.includes(check.actual);
  }
  return false;
}
