import type { RuntimeIdentityReport } from "../../src/runtime-identity-contracts.js";

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
