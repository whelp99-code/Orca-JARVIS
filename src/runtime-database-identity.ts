import type Database from "better-sqlite3";
import { buildHash, migrationVectorHash } from "./backend-build-files.js";
import type { BuildMigration, RuntimeIdentityReport } from "./runtime-identity-contracts.js";

export function databaseIdentity(
  db: Database.Database, expected: readonly BuildMigration[] | null, now: Date,
): RuntimeIdentityReport["database"] {
  const observed_at = Number.isFinite(now.getTime()) ? now.toISOString() : null;
  const unavailable = { status: "unavailable" as const, observed_at, applied_migrations: null,
    migration_digest: null, missing: null, unexpected: null, changed: null, schema_objects: null, schema_digest: null };
  try {
    return db.transaction(() => {
      const objects = db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name LIMIT 16385").all();
      const schema = JSON.stringify(objects);
      if (objects.length > 16_384 || Buffer.byteLength(schema) > 16 * 1024 * 1024) return unavailable;
      const structure = { schema_objects: objects.length, schema_digest: buildHash(`orca-jarvis/sqlite-schema/v1\0${schema}`) };
      const journal = db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='schema_migrations'").get();
      if (journal === undefined) return { ...unavailable, ...structure };
      const rows = db.prepare("SELECT id,checksum FROM schema_migrations ORDER BY id LIMIT 16385").all() as BuildMigration[];
      if (rows.length > 16_384 || rows.some(row => typeof row.id !== "string" || row.id.length > 2048
        || typeof row.checksum !== "string" || !/^[0-9a-f]{64}$/.test(row.checksum))) return { ...unavailable, ...structure };
      if (new Set(rows.map(row => row.id)).size !== rows.length) return { ...unavailable, ...structure };
      const common = { observed_at, applied_migrations: rows.length, migration_digest: migrationVectorHash(rows), ...structure };
      if (expected === null) return { ...unavailable, ...common, status: "unverified" as const };
      const actual = new Map(rows.map(row => [row.id, row.checksum]));
      const desired = new Map(expected.map(row => [row.id, row.checksum]));
      const missing = expected.filter(row => !actual.has(row.id)).length;
      const unexpected = rows.filter(row => !desired.has(row.id)).length;
      const changed = expected.filter(row => actual.has(row.id) && actual.get(row.id) !== row.checksum).length;
      return { ...common, missing, unexpected, changed,
        status: missing + unexpected + changed === 0 ? "matched" as const : "mismatch" as const };
    }).deferred();
  } catch { return unavailable; }
}
