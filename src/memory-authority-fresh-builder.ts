import { createHash } from "node:crypto";
import { chmodSync, existsSync, readFileSync, rmSync } from "node:fs";
import { canonicalize } from "./canonical.js";
import { AuthorityDb } from "./db.js";
import { JarvisError } from "./db.js";
import {
  collectSuppressedContent,
  removeSuppressedRows,
  suppressedProjections,
  type SuppressedProjection,
} from "./memory-compaction-sanitize.js";

const digest = (value: Buffer | string): string => `sha256:${createHash("sha256")
  .update(value).digest("hex")}`;

export type FreshAuthorityBuild = {
  readonly fresh_path: string;
  readonly source_digest: string;
  readonly result_digest: string;
  readonly logical_result_digest: string;
  readonly sensitive_material: Buffer[];
  readonly integrity_check: "ok";
  readonly foreign_key_errors: 0;
  readonly source_generation: number;
  readonly result_generation: number;
};

type SchemaRow = {
  readonly type: string;
  readonly name: string;
  readonly tbl_name: string;
  readonly sql: string | null;
};

export async function buildFreshAuthority(
  source: AuthorityDb,
  freshPath: string,
  input: {
    readonly blocked_projections?: readonly SuppressedProjection[];
    readonly sensitive_material?: readonly Buffer[];
  } = {},
): Promise<FreshAuthorityBuild> {
  const blockedProjections = input.blocked_projections ?? suppressedProjections(source.db);
  source.db.pragma("wal_checkpoint(TRUNCATE)");
  const sourceDigest = digest(readFileSync(source.filename));
  const sensitive = input.sensitive_material === undefined
    ? collectSuppressedContent(source.db, blockedProjections)
    : [...input.sensitive_material];
  rmSync(freshPath, { force: true });
  const fresh = new AuthorityDb(freshPath);
  try {
    await fresh.migrate();
    chmodSync(freshPath, 0o600);
    const sourceSchema = schemaRows(source);
    const targetSchema = schemaRows(fresh);
    const sourceTables = sourceSchema.filter(row => row.type === "table").map(row => row.name);
    const targetTables = targetSchema.filter(row => row.type === "table").map(row => row.name);
    if (canonicalize(sourceTables) !== canonicalize(targetTables)) {
      throw new JarvisError("MEMORY_COMPACTION_POLICY_INCOMPLETE");
    }
    const triggers = targetSchema.filter(row => row.type === "trigger" && row.sql !== null);
    fresh.db.pragma("foreign_keys=OFF");
    for (const trigger of triggers) fresh.db.exec(`DROP TRIGGER ${quote(trigger.name)}`);
    fresh.db.exec("CREATE TEMP TABLE blocked_projections(kind TEXT,id TEXT,component_id TEXT)");
    const insertBlocked = fresh.db.prepare(
      "INSERT INTO blocked_projections(kind,id,component_id) VALUES(?,?,?)",
    );
    for (const projection of blockedProjections) {
      insertBlocked.run(projection.kind, projection.id, projection.component_id);
    }
    fresh.db.prepare("ATTACH DATABASE ? AS source_authority").run(source.filename);
    try {
      for (const table of targetTables) {
        if (table === "schema_migrations" || table.startsWith("sqlite_")) continue;
        const columns = tableColumns(fresh, table);
        if (columns.length === 0) continue;
        fresh.db.exec(`DELETE FROM ${quote(table)}`);
        const list = columns.map(quote).join(",");
        const selected = columns.map(column => copyExpression(table, column)).join(",");
        fresh.db.exec(`INSERT INTO ${quote(table)}(${list})
          SELECT ${selected} FROM source_authority.${quote(table)} AS source_row
          ${copyFilter(table, columns)}`);
      }
    } finally {
      fresh.db.exec("DETACH DATABASE source_authority");
    }
    removeSuppressedRows(fresh.db, blockedProjections);
    for (const trigger of triggers) {
      if (trigger.sql === null) throw new JarvisError("MEMORY_COMPACTION_SCHEMA_INVALID");
      fresh.db.exec(trigger.sql);
    }
    fresh.db.pragma("foreign_keys=ON");
    const foreignKeys = fresh.db.pragma("foreign_key_check") as readonly unknown[];
    if (foreignKeys.length !== 0) throw new JarvisError("MEMORY_COMPACTION_FOREIGN_KEY_INVALID");
    const integrity = String(fresh.db.pragma("integrity_check", { simple: true }));
    if (integrity !== "ok") throw new JarvisError("MEMORY_COMPACTION_INTEGRITY_INVALID");
    const generation = fresh.db.prepare(
      "SELECT generation FROM memory_database_generations WHERE state='active'",
    ).get();
    const sourceGeneration = rowNumber(generation, "generation");
    const logicalDigest = logicalManifest(fresh);
    const at = new Date().toISOString();
    fresh.db.prepare(
      `UPDATE memory_database_generations SET state='retired',retired_at=?
       WHERE generation=? AND state='active'`,
    ).run(at, sourceGeneration);
    fresh.db.prepare(
      `INSERT INTO memory_database_generations(
        generation,database_manifest_digest,state,activated_at,retired_at
       ) VALUES(?,?,'active',?,NULL)`,
    ).run(sourceGeneration + 1, logicalDigest, at);
    fresh.db.pragma("wal_checkpoint(TRUNCATE)");
    fresh.close();
    removeSidecars(freshPath);
    const resultBytes = readFileSync(freshPath);
    if (sensitive.some(value => value.byteLength > 0 && resultBytes.includes(value))) {
      throw new JarvisError("MEMORY_COMPACTION_PHYSICAL_SCAN_FAILED");
    }
    return { fresh_path: freshPath, source_digest: sourceDigest,
      result_digest: digest(resultBytes), logical_result_digest: logicalDigest,
      sensitive_material: sensitive, integrity_check: "ok", foreign_key_errors: 0,
      source_generation: sourceGeneration, result_generation: sourceGeneration + 1 };
  } catch (error) {
    if (fresh.db.open) fresh.close();
    removeSidecars(freshPath);
    rmSync(freshPath, { force: true });
    throw error;
  }
}

function schemaRows(database: AuthorityDb): readonly SchemaRow[] {
  return database.db.prepare(
    `SELECT type,name,tbl_name,sql FROM sqlite_master
     WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name`,
  ).all().map(value => {
    if (value === null || typeof value !== "object") throw new JarvisError("MEMORY_COMPACTION_SCHEMA_INVALID");
    const type = Reflect.get(value, "type"); const name = Reflect.get(value, "name");
    const table = Reflect.get(value, "tbl_name"); const sql = Reflect.get(value, "sql");
    if (typeof type !== "string" || typeof name !== "string" || typeof table !== "string"
      || (sql !== null && typeof sql !== "string")) throw new JarvisError("MEMORY_COMPACTION_SCHEMA_INVALID");
    return { type, name, tbl_name: table, sql };
  });
}

function tableColumns(database: AuthorityDb, table: string): readonly string[] {
  return database.db.prepare(`PRAGMA table_xinfo(${quote(table)})`).all().flatMap(value => {
    if (value === null || typeof value !== "object") return [];
    const name = Reflect.get(value, "name"); const hidden = Reflect.get(value, "hidden");
    return typeof name === "string" && hidden === 0 ? [name] : [];
  });
}

function copyExpression(table: string, column: string): string {
  if (table === "control_command_requests" && (column === "target_json" || column === "args_json")) {
    return `CASE WHEN EXISTS (SELECT 1 FROM blocked_projections p
      WHERE p.kind IN ('control_payload','restore_control') AND p.id=source_row.request_id)
      THEN '{"purged":true}' ELSE source_row.${quote(column)} END`;
  }
  return `source_row.${quote(column)}`;
}

function copyFilter(table: string, columns: readonly string[]): string {
  const projection = "blocked_projections";
  if (table === "memory_outbox") return `WHERE NOT EXISTS (SELECT 1 FROM ${projection} p
    WHERE (p.kind='candidate' AND p.id=source_row.candidate_id)
       OR (p.kind='outbox' AND p.id=source_row.outbox_id))`;
  if (columns.includes("candidate_id") && table !== "memory_correction_requests") {
    return `WHERE NOT EXISTS (SELECT 1 FROM ${projection} p
      WHERE p.kind='candidate' AND p.id=source_row.candidate_id)`;
  }
  if (["memory_outbox_attempts", "memory_reconciliation_events", "memory_scoped_completion_observations",
    "memory_scoped_settlements"].includes(table)) {
    return `WHERE NOT EXISTS (SELECT 1 FROM ${projection} p
      WHERE p.kind='outbox' AND p.id=source_row.outbox_id)
      AND NOT EXISTS (SELECT 1 FROM source_authority.memory_outbox o
      JOIN ${projection} p ON p.kind='candidate' AND p.id=o.candidate_id
      WHERE o.outbox_id=source_row.outbox_id)`;
  }
  if (table === "notification_intents") return `WHERE NOT EXISTS (SELECT 1 FROM ${projection} p
    WHERE p.kind='notification_intent' AND p.id=source_row.intent_id)`;
  if (table === "notification_deliveries") return `WHERE NOT EXISTS (SELECT 1 FROM ${projection} p
    WHERE (p.kind='notification_delivery' AND p.id=source_row.delivery_id)
       OR (p.kind='notification_intent' AND p.id=source_row.intent_id))`;
  if (table.startsWith("personal_context_") && table !== "personal_context_audit_events"
    && columns.includes("context_id")) {
    return `WHERE NOT EXISTS (SELECT 1 FROM ${projection} p
      WHERE p.kind='context' AND p.id=source_row.context_id)`;
  }
  if (table.startsWith("personal_recommendation") && columns.includes("recommendation_id")) {
    return `WHERE NOT EXISTS (
    SELECT 1 FROM ${projection} p WHERE p.id=source_row.recommendation_id
      AND p.kind IN ('recommendation','recommendation_action'))`;
  }
  if (table === "personal_observations") return `WHERE NOT EXISTS (SELECT 1 FROM ${projection} p
    WHERE p.kind='observation' AND p.id=source_row.observation_id)`;
  if (table === "personal_source_checkpoints") return `WHERE NOT EXISTS (SELECT 1 FROM ${projection} p
    WHERE p.kind='observation' AND p.id=source_row.observation_id)`;
  if (table === "daily_loop_runs") return `WHERE NOT EXISTS (SELECT 1 FROM ${projection} p
    WHERE p.kind='daily_run' AND p.id=source_row.run_id)`;
  if (table === "daily_loop_steps") return `WHERE NOT EXISTS (SELECT 1 FROM ${projection} p
    WHERE (p.kind='daily_run' AND p.id=source_row.run_id)
       OR (p.kind IN ('daily_step','morning_brief','evening_closeout')
         AND p.id=source_row.step_id))`;
  if (table === "daily_loop_checkpoints") return `WHERE NOT EXISTS (SELECT 1 FROM ${projection} p
    WHERE (p.kind='daily_run' AND p.id=source_row.run_id)
       OR (p.kind IN ('daily_step','morning_brief','evening_closeout')
         AND p.id=source_row.step_id))`;
  return "";
}

function logicalManifest(database: AuthorityDb): string {
  const rows = database.db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  ).all().map(value => {
    if (value === null || typeof value !== "object" || typeof Reflect.get(value, "name") !== "string") {
      throw new JarvisError("MEMORY_COMPACTION_SCHEMA_INVALID");
    }
    const name = String(Reflect.get(value, "name"));
    const count = database.db.prepare(`SELECT COUNT(*) AS count FROM ${quote(name)}`).get();
    return { name, rows: rowNumber(count, "count") };
  });
  return digest(canonicalize(rows));
}

function rowNumber(value: unknown, key: string): number {
  const observed = value !== null && typeof value === "object" ? Reflect.get(value, key) : undefined;
  if (typeof observed !== "number" || !Number.isSafeInteger(observed)) {
    throw new JarvisError("MEMORY_COMPACTION_ROW_INVALID");
  }
  return observed;
}

function removeSidecars(path: string): void {
  for (const suffix of ["-wal", "-shm", "-journal"]) {
    if (existsSync(`${path}${suffix}`)) rmSync(`${path}${suffix}`, { force: true });
  }
}

function quote(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}
