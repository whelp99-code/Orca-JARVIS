import type Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { inferredMemoryInput, verifiedMemoryInput } from "../fixtures/memory-candidate-fixture.js";
import {
  closeMemoryDatabase,
  memoryCandidateStore,
  memoryDatabase,
  memoryRecord,
  seedMemoryVerification,
} from "../fixtures/memory-candidate-store.js";

const TABLES = [
  "memory_candidate_classifications",
  "memory_candidate_source_refs",
  "memory_candidate_idempotency",
  "memory_candidate_verification_authority",
  "memory_candidate_authority_claims",
] as const;

function cloneTable(database: Database.Database, table: string): void {
  const row = memoryRecord(database.prepare(
    "SELECT sql FROM sqlite_master WHERE type='table' AND name=?",
  ).get(table));
  database.exec("DROP TABLE IF EXISTS task27_runtime_probe");
  database.exec(String(row["sql"]).replace(`CREATE TABLE ${table}`, "CREATE TABLE task27_runtime_probe"));
  database.exec(`INSERT INTO task27_runtime_probe SELECT * FROM ${table}`);
}

function expectConstraint(database: Database.Database, column: string, value: unknown, label: string): void {
  expect(() => database.prepare(`UPDATE task27_runtime_probe SET ${column}=?`).run(value), label)
    .toThrow(/constraint/i);
}

function plan(database: Database.Database, sql: string, ...parameters: unknown[]): string {
  return (database.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...parameters) as Array<Record<string, unknown>>)
    .map(row => String(row["detail"]))
    .join("\n");
}

function insertCopy(
  database: Database.Database,
  table: string,
  replacements: Readonly<Record<string, unknown>>,
): void {
  const columns = (database.prepare(`PRAGMA table_info(${table})`).all() as Array<Record<string, unknown>>)
    .map(row => String(row["name"]));
  const values: unknown[] = [];
  const expressions = columns.map(column => {
    if (!Object.hasOwn(replacements, column)) return column;
    values.push(replacements[column]);
    return "?";
  });
  database.prepare(
    `INSERT INTO ${table}(${columns.join(",")}) SELECT ${expressions.join(",")} FROM ${table} LIMIT 1`,
  ).run(...values);
}

describe("Task 27 migration 038 runtime invariants", () => {
  it("executes the complete CHECK and FK matrix against populated real SQLite tables", async () => {
    const fixture = await memoryDatabase();
    try {
      const input = verifiedMemoryInput({ authority_id: "migration-runtime" });
      seedMemoryVerification(fixture.authority, input);
      memoryCandidateStore(fixture.authority).classify(input);
      const database = fixture.authority.db;
      expect(database.pragma("foreign_keys", { simple: true })).toBe(1);
      const foreignKeys: Readonly<Record<string, string>> = {
        memory_candidate_classifications: "memory_candidates",
        memory_candidate_source_refs: "memory_candidate_classifications",
        memory_candidate_idempotency: "memory_candidate_classifications",
        memory_candidate_verification_authority: "trusted_authority_keys",
        memory_candidate_authority_claims: "memory_candidate_classifications",
      };
      for (const table of TABLES) {
        const rows = database.prepare(`PRAGMA foreign_key_list(${table})`).all() as Array<Record<string, unknown>>;
        expect(rows.map(row => String(row["table"])), table).toEqual([foreignKeys[table]]);
      }
      const checks: Readonly<Record<string, ReadonlyArray<readonly [string, unknown]>>> = {
        memory_candidate_classifications: [
          ["schema_version", 2], ["input_digest", "bad"], ["identity_source_digest", "bad"],
          ["candidate_digest", "bad"], ["input_class", "foreign"], ["confidence", "foreign"],
          ["policy_sensitivity", "foreign"], ["retention_days", 0], ["confirmation_gate", "foreign"],
          ["policy_digest", "bad"], ["classification_digest", "bad"], ["dedup_key", "bad"],
          ["source_id", "source prose"], ["source_version", "v 2"], ["worker_session_digest", "bad"],
          ["control_command_digest", "bad"], ["inference_label", "foreign"], ["conflict_state", "foreign"],
          ["delivery_state", "foreign"], ["created_at", "not-a-time"],
        ],
        memory_candidate_source_refs: [
          ["position", -1], ["ref_kind", "foreign"], ["ref_namespace", "foreign"], ["ref_id", "A".repeat(64)],
          ["ref_version", 2], ["evidence_digest", "bad"], ["observed_at", "not-a-time"],
          ["fresh_until", "2026-08-28T11:54:59.999Z"], ["expires_at", "2026-08-28T11:54:59.999Z"],
        ],
        memory_candidate_idempotency: [
          ["idempotency_digest", "bad"], ["request_digest", "bad"], ["input_digest", "bad"],
          ["created_at", "not-a-time"],
        ],
        memory_candidate_verification_authority: [
          ["evidence_id", "bad evidence"], ["schema_version", 2], ["candidate_id", "bad"],
          ["correlation_id", "bad"], ["source_id", "bad source"], ["source_version", "bad version"],
          ["subject_digest", "bad"], ["content_digest", "bad"], ["operation", "foreign"],
          ["purpose", "foreign"], ["sensitivity", "foreign"], ["outcome", "failed"],
          ["attempt_id", "bad attempt"], ["worker_id", "bad worker"], ["worker_session_id", "bad session"],
          ["verifier_id", "bad verifier"], ["artifact_id", "bad artifact"], ["evidence_digest", "bad"],
          ["issued_at", "not-a-time"], ["not_before", "2026-08-28T12:06:00.000Z"],
          ["expires_at", "2026-08-28T11:54:59.999Z"], ["nonce", "bad nonce"], ["max_uses", 2],
          ["status", "revoked"], ["created_at", "not-a-time"],
        ],
        memory_candidate_authority_claims: [
          ["authority_kind", "foreign"], ["classification_digest", "bad"], ["claimed_at", "not-a-time"],
        ],
      };
      for (const table of TABLES) {
        cloneTable(database, table);
        for (const [column, value] of checks[table] ?? []) {
          expectConstraint(database, column, value, `${table}.${column}`);
        }
      }
      const missingCandidate = `memcand:pos:v1:${"f".repeat(64)}`;
      cloneTable(database, "memory_candidate_classifications");
      expectConstraint(database, "candidate_id", missingCandidate, "classification FK");
      cloneTable(database, "memory_candidate_source_refs");
      expectConstraint(database, "candidate_id", missingCandidate, "source reference FK");
      cloneTable(database, "memory_candidate_idempotency");
      expectConstraint(database, "candidate_id", missingCandidate, "idempotency FK");
      cloneTable(database, "memory_candidate_verification_authority");
      expect(() => database.prepare(
        "UPDATE task27_runtime_probe SET signer_key_id='missing-key',verifier_key_id='missing-key'",
      ).run()).toThrow(/constraint/i);
      cloneTable(database, "memory_candidate_authority_claims");
      expectConstraint(database, "candidate_id", missingCandidate, "claim FK");
    } finally {
      closeMemoryDatabase(fixture);
    }
  });

  it("uses every named migration-038 index for its exact lookup shape", async () => {
    const fixture = await memoryDatabase();
    try {
      const input = verifiedMemoryInput({ authority_id: "migration-index" });
      seedMemoryVerification(fixture.authority, input);
      const result = memoryCandidateStore(fixture.authority).classify(input);
      const database = fixture.authority.db;
      const reference = result.source_refs[0];
      if (!reference) throw new TypeError("source reference required");
      const queries = [
        ["memory_candidate_classification_source",
          "SELECT candidate_id FROM memory_candidate_classifications WHERE source_id=? AND input_class=? ORDER BY created_at,candidate_id",
          [result.source.source_id, result.input_class]],
        ["memory_candidate_classification_policy",
          "SELECT candidate_id FROM memory_candidate_classifications WHERE policy_digest=? AND classification_reason=? ORDER BY created_at,candidate_id",
          [result.policy_digest, result.classification_reason]],
        ["memory_candidate_source_ref_identity",
          "SELECT candidate_id FROM memory_candidate_source_refs WHERE ref_namespace=? AND ref_id=? AND ref_version=? AND evidence_digest=?",
          [reference.identifier.namespace, reference.identifier.id, reference.identifier.version, reference.evidence_digest]],
        ["memory_candidate_idempotency_candidate",
          "SELECT idempotency_digest FROM memory_candidate_idempotency WHERE candidate_id=? ORDER BY created_at,idempotency_digest",
          [result.candidate_id]],
      ] as const;
      for (const [index, sql, parameters] of queries) {
        expect(plan(database, sql, ...parameters), index).toContain(index);
      }
    } finally {
      closeMemoryDatabase(fixture);
    }
  });

  it("executes insert guards and update/delete immutability on populated rows", async () => {
    const fixture = await memoryDatabase();
    try {
      const input = verifiedMemoryInput({ authority_id: "migration-guards" });
      seedMemoryVerification(fixture.authority, input);
      const result = memoryCandidateStore(fixture.authority).classify(input);
      const database = fixture.authority.db;
      const immutable: Readonly<Record<string, string>> = {
        memory_candidate_classifications: "immutable memory candidate classification",
        memory_candidate_source_refs: "immutable memory candidate source reference",
        memory_candidate_idempotency: "immutable memory candidate idempotency",
        memory_candidate_verification_authority: "immutable memory verification authority",
        memory_candidate_authority_claims: "immutable memory candidate authority claim",
      };
      for (const table of TABLES) {
        const firstColumn = String(memoryRecord(database.prepare(`PRAGMA table_info(${table})`).get())["name"]);
        expect(() => database.prepare(`UPDATE ${table} SET ${firstColumn}=${firstColumn}`).run())
          .toThrow(immutable[table]);
        expect(() => database.prepare(`DELETE FROM ${table}`).run()).toThrow(immutable[table]);
      }
      expect(() => insertCopy(database, "memory_candidate_classifications", {
        candidate_id: `memcand:pos:v1:${"e".repeat(64)}`,
        candidate_digest: `sha256:${"1".repeat(64)}`,
        classification_digest: `sha256:${"2".repeat(64)}`,
        dedup_key: `sha256:${"3".repeat(64)}`,
      })).toThrow("memory candidate proposed row required");
      expect(() => insertCopy(database, "memory_candidate_idempotency", {
        idempotency_digest: `sha256:${"4".repeat(64)}`,
        request_digest: `sha256:${"5".repeat(64)}`,
        input_digest: `sha256:${"6".repeat(64)}`,
      })).toThrow("memory candidate classification binding required");
      expect(() => insertCopy(database, "memory_candidate_verification_authority", {
        evidence_id: "verification-cross-purpose-guard",
        candidate_id: `memcand:pos:v1:${"7".repeat(64)}`,
        correlation_id: `corr:memory:${"7".repeat(64)}`,
        nonce: "verification-cross-purpose-guard",
        verifier_key_id: "decision-test",
        signer_key_id: "decision-test",
      })).toThrow("memory verification authority key required");
      const unrelated = memoryCandidateStore(fixture.authority).classify(inferredMemoryInput({
        authority_id: "guard-unrelated",
      }));
      expect(() => database.prepare(
        `INSERT INTO memory_candidate_authority_claims(
          authority_kind,authority_id,candidate_id,classification_digest,claimed_at
         ) VALUES(?,?,?,?,?)`,
      ).run("verified_outcome", "verification-missing", unrelated.candidate_id,
        unrelated.classification_digest, unrelated.created_at)).toThrow("memory candidate authority binding required");
      expect(result.state).toBe("approved");
    } finally {
      closeMemoryDatabase(fixture);
    }
  });
});
