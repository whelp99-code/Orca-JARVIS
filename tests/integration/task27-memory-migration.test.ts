import { createHash } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AuthorityDb } from "../../src/index.js";

const MIGRATION = "038_memory_candidate_classification.sql";
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
          "candidate_id", "schema_version", "input_digest", "candidate_digest", "input_class", "confidence",
          "policy_sensitivity", "retention_days", "confirmation_gate", "policy_digest", "classification_reason",
          "classification_digest", "dedup_key", "source_id", "source_version", "owner_principal",
          "authenticated_session_id", "worker_id", "verifier_id", "control_request_id", "control_receipt_id",
          "control_command_digest", "inference_label", "conflict_state", "delivery_state", "delivery_reason", "created_at",
        ],
        memory_candidate_source_refs: [
          "candidate_id", "position", "ref_kind", "source_ref", "evidence_digest", "observed_at", "fresh_until",
          "expires_at",
        ],
        memory_candidate_idempotency: [
          "idempotency_digest", "request_digest", "input_digest", "candidate_id", "created_at",
        ],
      };
      for (const [table, expected] of Object.entries(expectedColumns)) {
        const rows: readonly unknown[] = authority.db.prepare(`PRAGMA table_info(${table})`).all();
        expect(rows.map(value => record(value)["name"]), table).toEqual(expected);
      }
      const triggers: readonly unknown[] = authority.db.prepare(
        `SELECT name FROM sqlite_master
         WHERE type='trigger' AND tbl_name IN (
           'memory_candidate_classifications','memory_candidate_source_refs','memory_candidate_idempotency'
         ) AND name LIKE '%immutable%' ORDER BY name`,
      ).all();
      expect(triggers.map(value => record(value)["name"])).toEqual([
        "memory_candidate_classification_immutable_delete",
        "memory_candidate_classification_immutable_update",
        "memory_candidate_idempotency_immutable_delete",
        "memory_candidate_idempotency_immutable_update",
        "memory_candidate_source_ref_immutable_delete",
        "memory_candidate_source_ref_immutable_update",
      ]);
    } finally {
      authority.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("applies after an unrelated migration 037 without reading Task 26 schema", async () => {
    // Given: the exact Task 27 set plus an unrelated no-op Task 26 slot 037.
    const directory = migrationDirectory();
    writeFileSync(join(directory.path, "037_task26_placeholder.sql"), "CREATE TABLE task26_placeholder(id TEXT PRIMARY KEY);\n");
    const authority = new AuthorityDb(join(directory.root, "authority.sqlite"), directory.path);
    try {
      // When: the complete ordered set is migrated.
      await authority.migrate();

      // Then: both slots journal independently and Task 27 foreign keys target only baseline tables.
      const rows: readonly unknown[] = authority.db.prepare(
        "SELECT id FROM schema_migrations WHERE id>='037_' ORDER BY id",
      ).all();
      expect(rows.map(value => record(value)["id"])).toEqual(["037_task26_placeholder.sql", MIGRATION]);
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
