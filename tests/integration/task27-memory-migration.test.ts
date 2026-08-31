import { createHash } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AuthorityDb } from "../../src/index.js";
import { verifiedMemoryInput } from "../fixtures/memory-candidate-fixture.js";
import {
  closeMemoryDatabase,
  memoryCandidateStore,
  memoryDatabase,
  seedMemoryVerification,
} from "../fixtures/memory-candidate-store.js";

const MIGRATION = "038_memory_candidate_classification.sql";
const TASK29_MIGRATION = "039_memory_outbox_saga.sql";
const BASELINE_MANIFEST_DIGEST = "fed3a674aa63174052b28f4268871373254719966a78563d3291f7e967034d82";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new TypeError("record required");
  return value;
}

function migrationDirectory(): { readonly root: string; readonly path: string } {
  const root = mkdtempSync(join(tmpdir(), "jarvis-task27-migrations-"));
  const path = join(root, "migrations");
  cpSync(join(process.cwd(), "migrations"), path, { recursive: true });
  return { root, path };
}

function baselineManifestDigest(): string {
  const names = readdirSync(join(process.cwd(), "migrations"))
    .filter(name => name.endsWith(".sql") && name <= "036_notification_intent_immutable_delete.sql")
    .sort();
  const manifest = names.map(name => {
    const bytes = readFileSync(join(process.cwd(), "migrations", name));
    return `${createHash("sha256").update(bytes).digest("hex")}  ${name}\n`;
  }).join("");
  if (names.length !== 36) throw new TypeError("Task 27 baseline migration count changed");
  return createHash("sha256").update(manifest).digest("hex");
}

describe("Task 27 forward memory classification migration", () => {
  it("keeps migration 038 within the production reviewability limits", () => {
    const lines = readFileSync(join(process.cwd(), "migrations", MIGRATION), "utf8").split("\n");
    expect(lines.filter(line => line.trim() !== "").length).toBeLessThanOrEqual(250);
    expect(Math.max(...lines.map(line => line.length))).toBeLessThanOrEqual(160);
  });

  it("preserves every baseline 001-036 migration byte", () => {
    // Given/When: the complete baseline migration manifest is hashed in filename order.
    const digest = baselineManifestDigest();

    // Then: all 36 immutable source files match the frozen baseline.
    expect(digest).toBe(BASELINE_MANIFEST_DIGEST);
  });

  it("publishes exact immutable classification, source-reference, and idempotency tables", async () => {
    // Given: a fresh authority database with the independent Task 27 migration set.
    const root = mkdtempSync(join(tmpdir(), "jarvis-task27-schema-"));
    const authority = new AuthorityDb(join(root, "authority.sqlite"));
    try {
      // When: all migrations are applied twice.
      await authority.migrate();
      await authority.migrate();

      // Then: migration 038 is journaled once and all normalized tables expose the exact keys.
      expect(record(authority.db.prepare(
        "SELECT COUNT(*) AS count FROM schema_migrations WHERE id=?",
      ).get(MIGRATION))["count"]).toBe(1);
      const expectedColumns: Readonly<Record<string, readonly string[]>> = {
        memory_candidate_classifications: [
          "candidate_id", "schema_version", "input_digest", "identity_source_digest", "candidate_digest", "input_class",
          "confidence", "policy_sensitivity", "retention_days", "confirmation_gate", "policy_digest",
          "classification_reason", "classification_digest", "dedup_key", "source_id", "source_version", "owner_principal",
          "authenticated_session_digest", "worker_id", "worker_session_digest", "verifier_id", "instruction_id",
          "outcome_id", "attempt_id", "verification_evidence_id", "control_request_id", "control_receipt_id",
          "control_command_digest", "authority_key_id", "authority_expires_at", "inference_id", "inference_label",
          "conflict_state", "delivery_state", "delivery_reason", "created_at",
        ],
        memory_candidate_source_refs: [
          "candidate_id", "position", "ref_kind", "ref_namespace", "ref_id", "ref_version", "evidence_digest",
          "observed_at", "fresh_until", "expires_at",
        ],
        memory_candidate_idempotency: [
          "idempotency_digest", "request_digest", "input_digest", "candidate_id", "created_at",
        ],
        memory_candidate_verification_authority: [
          "evidence_id", "schema_version", "candidate_id", "correlation_id", "principal_id", "source_id",
          "source_version", "subject_digest", "content_digest", "operation", "purpose", "sensitivity", "outcome_id",
          "outcome", "attempt_id", "worker_id", "worker_session_id", "verifier_id", "verifier_key_id", "artifact_id",
          "evidence_digest", "issued_at", "not_before", "expires_at", "nonce", "max_uses", "status", "signer_key_id",
          "payload_json", "signature", "created_at",
        ],
        memory_candidate_authority_claims: [
          "authority_kind", "authority_id", "candidate_id", "classification_digest", "claimed_at",
        ],
      };
      for (const [table, expected] of Object.entries(expectedColumns)) {
        const rows: readonly unknown[] = authority.db.prepare(`PRAGMA table_info(${table})`).all();
        expect(rows.map(value => record(value)["name"]), table).toEqual(expected);
      }
      const triggers: readonly unknown[] = authority.db.prepare(
        `SELECT name FROM sqlite_master
         WHERE type='trigger' AND tbl_name IN (
           'memory_candidate_classifications','memory_candidate_source_refs','memory_candidate_idempotency',
           'memory_candidate_verification_authority','memory_candidate_authority_claims'
         ) AND name LIKE '%immutable%' ORDER BY name`,
      ).all();
      expect(triggers.map(value => record(value)["name"])).toEqual([
        "memory_candidate_authority_claim_immutable_delete",
        "memory_candidate_authority_claim_immutable_update",
        "memory_candidate_classification_immutable_delete",
        "memory_candidate_classification_immutable_update",
        "memory_candidate_idempotency_immutable_delete",
        "memory_candidate_idempotency_immutable_update",
        "memory_candidate_source_ref_immutable_delete",
        "memory_candidate_source_ref_immutable_update",
        "memory_verification_authority_immutable_delete",
        "memory_verification_authority_immutable_update",
      ]);
    } finally {
      authority.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("enforces lowercase hexadecimal bytes on every migration-038 digest column", async () => {
    const database = await memoryDatabase();
    try {
      const input = verifiedMemoryInput({ authority_id: "migration-digests" });
      seedMemoryVerification(database.authority, input);
      memoryCandidateStore(database.authority).classify(input);
      const digestColumns: Readonly<Record<string, readonly string[]>> = {
        memory_candidate_classifications: [
          "input_digest", "identity_source_digest", "candidate_digest", "policy_digest", "classification_digest",
          "dedup_key", "authenticated_session_digest", "worker_session_digest", "control_command_digest",
        ],
        memory_candidate_source_refs: ["evidence_digest"],
        memory_candidate_idempotency: ["idempotency_digest", "request_digest", "input_digest"],
        memory_candidate_verification_authority: ["subject_digest", "content_digest", "evidence_digest"],
        memory_candidate_authority_claims: ["classification_digest"],
      };
      for (const [table, columns] of Object.entries(digestColumns)) {
        const row = record(database.authority.db.prepare(
          "SELECT sql FROM sqlite_master WHERE type='table' AND name=?",
        ).get(table));
        const sql = String(row["sql"]);
        database.authority.db.exec("DROP TABLE IF EXISTS task27_digest_probe");
        database.authority.db.exec(sql.replace(`CREATE TABLE ${table}`, "CREATE TABLE task27_digest_probe"));
        database.authority.db.exec(`INSERT INTO task27_digest_probe SELECT * FROM ${table}`);
        for (const column of columns) {
          for (const invalid of [`sha256:G${"0".repeat(63)}`, `sha256:z${"0".repeat(63)}`]) {
            expect(() => database.authority.db.prepare(
              `UPDATE task27_digest_probe SET ${column}=?`,
            ).run(invalid), `${table}.${column}`).toThrow(/constraint/i);
          }
        }
      }
    } finally {
      closeMemoryDatabase(database);
    }
  });

  it("upgrades an exact prior-036 database through current 037 and 038 without changing prior data", async () => {
    const directory = migrationDirectory();
    rmSync(join(directory.path, MIGRATION));
    const database = join(directory.root, "authority.sqlite");
    const prior = new AuthorityDb(database, directory.path);
    try {
      await prior.migrate();
      prior.db.prepare("INSERT INTO projects(id,target_kind,created_at) VALUES(?,?,?)")
        .run("task27-upgrade-sentinel", "codex", "2026-08-28T00:00:00.000Z");
    } finally {
      prior.close();
    }
    const fixture = join(process.cwd(), "tests", "fixtures", "task27", "037_recommendation_work_runtime.sql");
    writeFileSync(join(directory.path, "037_recommendation_work_runtime.sql"), readFileSync(fixture));
    writeFileSync(join(directory.path, MIGRATION), readFileSync(join(process.cwd(), "migrations", MIGRATION)));
    const upgraded = new AuthorityDb(database, directory.path);
    try {
      await upgraded.migrate();
      expect(record(upgraded.db.prepare(
        "SELECT id,target_kind,created_at FROM projects WHERE id='task27-upgrade-sentinel'",
      ).get())).toEqual({
        id: "task27-upgrade-sentinel",
        target_kind: "codex",
        created_at: "2026-08-28T00:00:00.000Z",
      });
      const rows: readonly unknown[] = upgraded.db.prepare(
        "SELECT id FROM schema_migrations WHERE id>='037_' ORDER BY id",
      ).all();
      expect(rows.map(value => record(value)["id"]))
        .toEqual(["037_recommendation_work_runtime.sql", MIGRATION, TASK29_MIGRATION]);
      expect(record(upgraded.db.prepare(
        "SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name='memory_candidate_classifications'",
      ).get())["count"]).toBe(1);
    } finally {
      upgraded.close();
      rmSync(directory.root, { recursive: true, force: true });
    }
  });

  it("applies after the exact current Task 26 migration 037", async () => {
    const directory = migrationDirectory();
    const fixture = join(process.cwd(), "tests", "fixtures", "task27", "037_recommendation_work_runtime.sql");
    const bytes = readFileSync(fixture);
    expect(createHash("sha256").update(bytes).digest("hex"))
      .toBe("a231ce3f25b7e7bd495dc3b24a40cd826c761d85f75524d495ff9e060f51645b");
    writeFileSync(join(directory.path, "037_recommendation_work_runtime.sql"), bytes);
    const authority = new AuthorityDb(join(directory.root, "authority.sqlite"), directory.path);
    try {
      await authority.migrate();
      const rows: readonly unknown[] = authority.db.prepare(
        "SELECT id FROM schema_migrations WHERE id>='037_' ORDER BY id",
      ).all();
      expect(rows.map(value => record(value)["id"]))
        .toEqual(["037_recommendation_work_runtime.sql", MIGRATION, TASK29_MIGRATION]);
      expect(record(authority.db.prepare(
        "SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name LIKE 'recommendation_work_%'",
      ).get())["count"]).toBe(12);
      expect(record(authority.db.prepare(
        "SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name='recommendation_verified_outcomes'",
      ).get())["count"]).toBe(1);
      expect(record(authority.db.prepare(
        "SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name='memory_candidate_classifications'",
      ).get())["count"]).toBe(1);
    } finally {
      authority.close();
      rmSync(directory.root, { recursive: true, force: true });
    }
  });

  it("applies after an unrelated migration 037 without reading Task 26 schema", async () => {
    // Given: the exact Task 27 set plus an unrelated no-op Task 26 slot 037.
    const directory = migrationDirectory();
    rmSync(join(directory.path, "037_recommendation_work_runtime.sql"));
    writeFileSync(join(directory.path, "037_task26_placeholder.sql"), "CREATE TABLE task26_placeholder(id TEXT PRIMARY KEY);\n");
    const authority = new AuthorityDb(join(directory.root, "authority.sqlite"), directory.path);
    try {
      // When: the complete ordered set is migrated.
      await authority.migrate();

      // Then: both slots journal independently and Task 27 foreign keys target only baseline tables.
      const rows: readonly unknown[] = authority.db.prepare(
        "SELECT id FROM schema_migrations WHERE id>='037_' ORDER BY id",
      ).all();
      expect(rows.map(value => record(value)["id"]))
        .toEqual(["037_task26_placeholder.sql", MIGRATION, TASK29_MIGRATION]);
      const foreignKeys: readonly unknown[] = authority.db.prepare(
        "PRAGMA foreign_key_list(memory_candidate_classifications)",
      ).all();
      expect(foreignKeys.map(value => record(value)["table"])).toEqual(["memory_candidates"]);
    } finally {
      authority.close();
      rmSync(directory.root, { recursive: true, force: true });
    }
  });
});
