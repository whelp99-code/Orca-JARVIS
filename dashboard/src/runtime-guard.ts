import type { RuntimeIdentityReport } from "../../src/runtime-identity-contracts.js";
import type { DaemonRuntimeIdentityReport } from "../../src/daemon-runtime-identity.js";

type RecordValue = Record<string, unknown>;
const record = (v: unknown): v is RecordValue => typeof v === "object" && v !== null && !Array.isArray(v);
const matches = (v: unknown, pattern: RegExp): boolean => typeof v === "string" && pattern.test(v);
const member = (v: unknown, values: readonly string[]): boolean => typeof v === "string" && values.includes(v);
const nullable = (v: unknown, check: (v: unknown) => boolean): boolean => v === null || check(v);
const count = (v: unknown): boolean => typeof v === "number" && Number.isSafeInteger(v) && v >= 0 && v <= 16_384;
const hash = (v: unknown): boolean => matches(v, /^sha256:[0-9a-f]{64}$/);
function timestamp(v: unknown): boolean {
  if (typeof v !== "string" || v.length > 27 || !Number.isFinite(Date.parse(v))) return false;
  return new Date(v).toISOString() === v;
}
function processIdentity(v: unknown): boolean {
  return record(v) && typeof v.pid === "number" && Number.isSafeInteger(v.pid) && v.pid > 0
    && timestamp(v.started_at) && matches(v.node, /^v\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/)
    && matches(v.modules, /^\d{1,6}$/) && matches(v.platform, /^[a-z0-9_]{1,32}$/) && matches(v.arch, /^[a-z0-9_]{1,32}$/);
}
function buildIdentity(v: unknown): boolean {
  return record(v) && member(v.status, ["matched", "mismatch", "missing", "invalid", "unreadable"])
    && timestamp(v.checked_at) && nullable(v.source_head, value => matches(value, /^[0-9a-f]{40}$/))
    && nullable(v.source_dirty, value => typeof value === "boolean")
    && ["input_digest", "artifact_digest", "observed_artifact_digest", "migration_digest"].every(key => nullable(v[key], hash))
    && nullable(v.artifact_files, count) && nullable(v.migration_count, count)
    && member(v.toolchain_status, ["matched", "mismatch", "unknown"]);
}
function databaseIdentity(v: unknown): boolean {
  return record(v) && member(v.status, ["matched", "mismatch", "unverified", "unavailable"])
    && nullable(v.observed_at, timestamp)
    && ["applied_migrations", "missing", "unexpected", "changed", "schema_objects"].every(key => nullable(v[key], count))
    && nullable(v.migration_digest, hash) && nullable(v.schema_digest, hash);
}
export function isRuntimeIdentity(value: unknown): value is RuntimeIdentityReport {
  return record(value) && value.schema_version === 1 && processIdentity(value.process)
    && buildIdentity(value.build) && databaseIdentity(value.database);
}

export function isDaemonRuntimeIdentity(value: unknown): value is DaemonRuntimeIdentityReport {
  if (!record(value) || value.schema_version !== 1 || !nullable(value.observed_at, timestamp)
    || !nullable(value.recorded_at, timestamp)) return false;
  const { lease, snapshot } = value;
  if (lease !== null && (!record(lease) || typeof lease.fence !== "number" || !Number.isSafeInteger(lease.fence)
    || lease.fence < 1 || !timestamp(lease.heartbeat_at) || !timestamp(lease.expires_at))) return false;
  if (snapshot !== null) {
    if (!record(snapshot) || snapshot.schema_version !== 1 || !processIdentity(snapshot.process) || !buildIdentity(snapshot.build)) return false;
    const incarnation = snapshot.incarnation;
    if (incarnation !== null && (!record(incarnation)
      || !matches(incarnation.boot_id, /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/)
      || !matches(incarnation.pid_namespace, /^pid:\[\d{1,58}\]$/) || !matches(incarnation.start_token, /^\d{1,32}$/))) return false;
  }
  const observed = Date.parse(String(value.observed_at));
  const recorded = Date.parse(String(value.recorded_at));
  const heartbeat = record(lease) ? Date.parse(String(lease.heartbeat_at)) : NaN;
  const expires = record(lease) ? Date.parse(String(lease.expires_at)) : NaN;
  const empty = snapshot === null && lease === null && value.recorded_at === null;
  const persisted = record(snapshot) && timestamp(value.recorded_at) && timestamp(value.observed_at);
  const bound = persisted && record(lease);
  const coherentClock = bound && recorded <= observed && heartbeat <= observed && heartbeat >= recorded;
  const current = coherentClock && expires > observed;
  const incarnation = record(snapshot) && record(snapshot.incarnation);
  if (value.status === "active") return value.reason === null && current && incarnation;
  if (value.status === "inactive") return value.reason === "lease_missing" ? persisted && lease === null
    : value.reason === "lease_expired" && coherentClock && expires <= observed;
  if (value.status === "stale") return value.reason === "lease_changed" ? bound
    : member(value.reason, ["process_missing", "process_exited", "incarnation_changed"]) && current && incarnation;
  if (value.status !== "unknown") return false;
  if (member(value.reason, ["missing", "invalid", "unavailable"])) return empty && timestamp(value.observed_at);
  if (value.reason === "clock_invalid") return (empty && value.observed_at === null) || (bound && !coherentClock);
  if (value.reason === "lease_invalid") return persisted && lease === null;
  if (value.reason === "process_unobservable") return current;
  return value.reason === "namespace_unobservable" && current && incarnation;
}
