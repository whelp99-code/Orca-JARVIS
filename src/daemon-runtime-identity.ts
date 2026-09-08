import { performance } from "node:perf_hooks";
import type Database from "better-sqlite3";
import { JarvisError } from "./authority-db-base.js";
import { captureRuntimeBuildIdentity } from "./runtime-identity.js";
import { observeRuntimeProcess, type RuntimeProcessObserver } from "./runtime-process-identity.js";
import { parseDaemonRuntimeSnapshot, validRuntimeTimestamp, type DaemonRuntimeSnapshot } from "./daemon-runtime-identity-schema.js";

export type { DaemonRuntimeSnapshot } from "./daemon-runtime-identity-schema.js";
export type DaemonRuntimeIdentityReport = {
  readonly schema_version: 1;
  readonly status: "active" | "inactive" | "stale" | "unknown";
  readonly reason: "missing" | "invalid" | "unavailable" | "clock_invalid" | "lease_missing" | "lease_changed"
    | "lease_expired" | "lease_invalid" | "process_unobservable" | "namespace_unobservable"
    | "process_missing" | "process_exited" | "incarnation_changed" | null;
  readonly observed_at: string | null;
  readonly recorded_at: string | null;
  readonly lease: { readonly fence: number; readonly heartbeat_at: string; readonly expires_at: string } | null;
  readonly snapshot: DaemonRuntimeSnapshot | null;
};

/** First successful service cycle, not caller cwd and not an executable-memory attestation. */
export function captureDaemonRuntimeIdentity(): DaemonRuntimeSnapshot {
  const observation = observeRuntimeProcess(process.pid);
  return parseDaemonRuntimeSnapshot({ schema_version: 1,
    process: { pid: process.pid, started_at: new Date(performance.timeOrigin).toISOString(), node: process.version,
      modules: process.versions.modules, platform: process.platform, arch: process.arch },
    build: captureRuntimeBuildIdentity(), incarnation: observation.status === "running" ? observation.incarnation : null });
}

/** Called inside the same immediate transaction as the lease and runtime heartbeats. */
export function publishDaemonRuntimeIdentity(
  db: Database.Database, snapshot: DaemonRuntimeSnapshot, owner: string, fence: number, now: string,
): void {
  if (!db.inTransaction) throw new JarvisError("GJC_IDENTITY_TRANSACTION_REQUIRED");
  if (!db.prepare("SELECT 1 FROM gjc_runtime_leases WHERE id=1 AND owner=? AND fence=? AND expires_at>?").get(owner, fence, now)) {
    throw new JarvisError("GJC_STALE_LEASE");
  }
  const json = JSON.stringify(parseDaemonRuntimeSnapshot(snapshot));
  db.prepare(`INSERT INTO gjc_runtime_identity(id,lease_owner,lease_fence,snapshot_json,recorded_at) VALUES(1,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET lease_owner=excluded.lease_owner,lease_fence=excluded.lease_fence,
      snapshot_json=excluded.snapshot_json,recorded_at=excluded.recorded_at
    WHERE gjc_runtime_identity.lease_owner<>excluded.lease_owner OR gjc_runtime_identity.lease_fence<>excluded.lease_fence`)
    .run(owner, fence, json, now);
}

/** Bounded read-only observation. Unknown or stale must not be interpreted as an active build. */
export function readDaemonRuntimeIdentity(
  db: Database.Database | null, now: Date, observe: RuntimeProcessObserver = observeRuntimeProcess,
): DaemonRuntimeIdentityReport {
  const base: DaemonRuntimeIdentityReport = { schema_version: 1, status: "unknown", reason: "unavailable",
    observed_at: Number.isFinite(now.getTime()) ? now.toISOString() : null, recorded_at: null, lease: null, snapshot: null };
  if (base.observed_at === null) return { ...base, reason: "clock_invalid" };
  if (db === null) return base;
  try {
    return db.transaction((): DaemonRuntimeIdentityReport => {
      const row = db.prepare(`SELECT lease_fence,
        CASE WHEN length(CAST(lease_owner AS BLOB))<=1024 THEN lease_owner ELSE NULL END AS lease_owner,
        CASE WHEN length(recorded_at)<=27 THEN recorded_at ELSE NULL END AS recorded_at,
        CASE WHEN length(CAST(snapshot_json AS BLOB))<=8192 THEN snapshot_json ELSE NULL END AS snapshot_json
        FROM gjc_runtime_identity WHERE id=1`).get() as {
          lease_owner: unknown; lease_fence: unknown; recorded_at: unknown; snapshot_json: unknown;
        } | undefined;
      if (!row) return { ...base, reason: "missing" };
      if (typeof row.lease_owner !== "string" || row.lease_owner.length === 0
        || !Number.isSafeInteger(row.lease_fence) || Number(row.lease_fence) < 1
        || !validRuntimeTimestamp(row.recorded_at) || typeof row.snapshot_json !== "string") return { ...base, reason: "invalid" };
      let snapshot: DaemonRuntimeSnapshot;
      try { snapshot = parseDaemonRuntimeSnapshot(JSON.parse(row.snapshot_json)); }
      catch { return { ...base, reason: "invalid" }; }
      const current = { ...base, snapshot, recorded_at: row.recorded_at };
      const lease = db.prepare(`SELECT fence,
        CASE WHEN length(CAST(owner AS BLOB))<=1024 THEN owner ELSE NULL END AS owner,
        CASE WHEN length(heartbeat_at)<=27 THEN heartbeat_at ELSE NULL END AS heartbeat_at,
        CASE WHEN length(expires_at)<=27 THEN expires_at ELSE NULL END AS expires_at
        FROM gjc_runtime_leases WHERE id=1`).get() as {
        owner: unknown; fence: unknown; heartbeat_at: unknown; expires_at: unknown;
      } | undefined;
      if (!lease) return { ...current, status: "inactive", reason: "lease_missing" };
      if (typeof lease.owner !== "string" || lease.owner.length === 0 || !Number.isSafeInteger(lease.fence) || Number(lease.fence) < 1
        || !validRuntimeTimestamp(lease.heartbeat_at) || !validRuntimeTimestamp(lease.expires_at)) {
        return { ...current, reason: "lease_invalid" };
      }
      const bound = { ...current, lease: { fence: Number(lease.fence), heartbeat_at: lease.heartbeat_at, expires_at: lease.expires_at } };
      if (lease.owner !== row.lease_owner || lease.fence !== row.lease_fence) return { ...bound, status: "stale", reason: "lease_changed" };
      if (Date.parse(lease.heartbeat_at) > now.getTime() || Date.parse(row.recorded_at) > now.getTime()
        || Date.parse(lease.heartbeat_at) < Date.parse(row.recorded_at)) return { ...bound, reason: "clock_invalid" };
      if (Date.parse(lease.expires_at) <= now.getTime()) return { ...bound, status: "inactive", reason: "lease_expired" };
      if (snapshot.incarnation === null) return { ...bound, reason: "process_unobservable" };
      const process = observe(snapshot.process.pid);
      if (process.status === "unavailable") return { ...bound, reason: "process_unobservable" };
      if (process.status === "missing") return { ...bound, status: "stale", reason: "process_missing" };
      if (process.status === "exited") return { ...bound, status: "stale", reason: "process_exited" };
      if (process.incarnation === null) return { ...bound, reason: "process_unobservable" };
      if (process.incarnation.boot_id !== snapshot.incarnation.boot_id) return { ...bound, status: "stale", reason: "incarnation_changed" };
      if (process.incarnation.pid_namespace !== snapshot.incarnation.pid_namespace) return { ...bound, reason: "namespace_unobservable" };
      if (process.incarnation.start_token !== snapshot.incarnation.start_token) return { ...bound, status: "stale", reason: "incarnation_changed" };
      return { ...bound, status: "active", reason: null };
    }).deferred();
  } catch { return base; }
}
