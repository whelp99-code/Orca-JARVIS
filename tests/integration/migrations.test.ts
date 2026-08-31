import { createHash } from "node:crypto";
import { appendFileSync, cpSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AuthorityDb } from "../../src/index.js";
import { tempDb } from "../helpers.js";

const collaborationWriteAttempts = [
  "INSERT INTO collaboration_identities(identity_id,identity_type,display_name,public_key_pem,key_fingerprint,created_request_id,created_at) VALUES('agent:old','agent','Old Agent','pem','fingerprint','request:identity','2026-08-12T00:00:00.000Z')",
  "INSERT INTO collaboration_identity_revocations(revocation_id,identity_id,reason,request_id,revoked_at) VALUES('revocation:identity','agent:old','retired','request:identity-revocation','2026-08-12T00:00:00.000Z')",
  "INSERT INTO collaboration_rooms(room_id,room_type,name,description,visibility,created_by_identity_id,created_request_id,created_at) VALUES('room:old','general','Old Room','retired','private','agent:old','request:room','2026-08-12T00:00:00.000Z')",
  "INSERT INTO collaboration_memberships(membership_id,room_id,identity_id,role,permissions_json,created_request_id,joined_at) VALUES('membership:old','room:old','agent:old','agent','{}','request:membership','2026-08-12T00:00:00.000Z')",
  "INSERT INTO collaboration_membership_revocations(revocation_id,membership_id,reason,request_id,revoked_at) VALUES('revocation:membership','membership:old','retired','request:membership-revocation','2026-08-12T00:00:00.000Z')",
  "INSERT INTO collaboration_events(event_id,schema_version,room_id,event_type,author_identity_id,payload_json,payload_digest,approved_request_id,author_signature,created_at) VALUES('event:old',1,'room:old','message','agent:old','{}','sha256:payload','request:event','signature','2026-08-12T00:00:00.000Z')",
  "INSERT INTO collaboration_bridge_outbox(export_id,bridge,event_id,envelope_json,envelope_digest,state,created_request_id,created_at) VALUES('export:old','buzz','event:old','{}','sha256:envelope','pending','request:bridge','2026-08-12T00:00:00.000Z')",
];

describe("migrations", () => {
  it("preserves reviewed migration bytes", () => {
    const expected = new Map([
      ["021_approval_control_plane.sql", "75ebf5cb20ab0f1a357dd55a52899cf94bf44a788a1a01c07aa3c74135942c43"],
      ["022_loopgraph_runtime.sql", "2c1fdba25a351919ab0bd4ed80e217d80754af232bf85e9f93382bf349a3529b"],
      ["023_runbook_runtime.sql", "fcb7e46da4c8ee00f1c41a37ce4092f1b130a1da7738fb7338841246dd4685e2"],
      ["024_microloop_runtime.sql", "cfb32b72fe81ee92825cbb9518e2b52985674584a2a0fb6e9e1df9f50b632cba"],
      ["025_collaboration_workspace.sql", "edcf8f85b95cf20004bf355a1e8c7f65966292f841903340bbec7d66771f3305"],
      ["026_task_timeline.sql", "cb1e19353670d180a5b27ba077e27e506d66bc532d3ead1dd7e33059ba641770"],
      ["027_control_execution_hardening.sql", "a5004fed13610811c1d7b47cf15bc3d5a02388b80f18f0cd7a2e3d0a6a1c0172"],
      ["030_dashboard_portfolio_projection.sql", "ea58ca0a324793af837be8a179dd4a7b700943d5a6a8a0b0d765d065dcc24482"],
      ["035_daily_loop_durable_guards.sql", "5e8be32e037f0fa87a6139da97b883fd343dce98469d0fecd456009bae641fef"],
      ["036_notification_intent_immutable_delete.sql", "a36ba7cecf63f28cc9fa7f6be6ce9aed0e7e093681d754fb1e897605b807aeb2"],
    ]);

    for (const [name, checksum] of expected) {
      const source = readFileSync(join(process.cwd(), "migrations", name));
      expect(createHash("sha256").update(source).digest("hex"), name).toBe(checksum);
    }
  });

  it("applies every immutable forward migration repeatedly", async () => { const db = new AuthorityDb(tempDb()); await db.migrate(); await db.migrate(); const expected = readdirSync(join(process.cwd(), "migrations")).filter(file => file.endsWith(".sql")).length; expect((db.db.prepare("SELECT COUNT(*) AS n FROM schema_migrations").get() as { n: number }).n).toBe(expected); });
  it("applies personal context between 031 and 033 on empty and exact prior-031 databases", async () => {
    // Given isolated full and prior-031 migration directories
    const source = join(process.cwd(), "migrations");
    const full = join(mkdtempSync(join(tmpdir(), "jarvis-context-full-")), "migrations");
    const prior = join(mkdtempSync(join(tmpdir(), "jarvis-context-prior-")), "migrations");
    cpSync(source, full, { recursive: true }); cpSync(source, prior, { recursive: true });
    for (const file of readdirSync(prior)) if (file > "031_control_ingress_idempotency.sql") rmSync(join(prior, file));
    const empty = new AuthorityDb(tempDb(), full); const upgraded = new AuthorityDb(tempDb(), prior);
    try {
      await upgraded.migrate();
      // When the exact 032 and later migrations become available
      for (const file of readdirSync(full)) if (file >= "032_personal_context.sql") cpSync(join(full, file), join(prior, file));
      await empty.migrate(); await upgraded.migrate();
      // Then both journals preserve unique checksummed order through independent slot 038.
      for (const db of [empty, upgraded]) {
        const rows = db.db.prepare("SELECT id,checksum FROM schema_migrations WHERE id>='031_' ORDER BY id").all() as Array<{ id: string; checksum: string }>;
        expect(rows.map(row => row.id)).toEqual(["031_control_ingress_idempotency.sql", "032_personal_context.sql",
          "033_personal_operations.sql", "034_recommendation_transition_identity.sql", "035_daily_loop_durable_guards.sql",
          "036_notification_intent_immutable_delete.sql", "037_recommendation_work_runtime.sql",
          "038_memory_candidate_classification.sql", "039_memory_outbox_saga.sql",
          "040_memory_tombstone_authority.sql", "041_memory_correction_saga.sql",
          "042_memory_deletion_proof.sql", "043_memory_export_saga.sql",
          "044_memory_content_propagation.sql"]);
        expect(new Set(rows.map(row => row.checksum)).size).toBe(rows.length);
      }
    } finally { empty.close(); upgraded.close(); rmSync(join(full, ".."), { recursive: true, force: true }); rmSync(join(prior, ".."), { recursive: true, force: true }); }
  });
  it("fails closed when migration is pending or its raw SQL bytes change", async () => { const pending = new AuthorityDb(tempDb()); await expect(pending.assertMigrationsReady()).rejects.toMatchObject({ code: "MIGRATIONS_PENDING" }); const directory = join(mkdtempSync(join(tmpdir(), "jarvis-migrations-")), "migrations"); cpSync(join(process.cwd(), "migrations"), directory, { recursive: true }); const db = new AuthorityDb(tempDb(), directory); await db.migrate(); appendFileSync(join(directory, "002_harden_authority.sql"), "\n-- byte change\n"); await expect(db.assertMigrationsReady()).rejects.toMatchObject({ code: "MIGRATION_CHECKSUM_MISMATCH" }); });
  it("publishes the forward execution-hardening schema", async () => {
    const db = new AuthorityDb(tempDb());
    await db.migrate();
    const tables = (db.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map(row => row.name);
    expect(tables).toEqual(expect.arrayContaining(["control_command_revocations", "control_effect_attempts", "workflow_step_approvals"]));
    const attemptColumns = (db.db.prepare("PRAGMA table_info(control_effect_attempts)").all() as Array<{ name: string }>).map(row => row.name);
    expect(attemptColumns).toEqual(expect.arrayContaining(["idempotency_key", "state", "receipt_json", "receipt_digest", "error_code"]));
    const approvalColumns = (db.db.prepare("PRAGMA table_info(workflow_step_approvals)").all() as Array<{ name: string }>).map(row => row.name);
    expect(approvalColumns).toContain("lease_fence");
    db.close();
  });
  it("rejects every retired collaboration write on a fresh migrated database", async () => { const root = mkdtempSync(join(tmpdir(), "jarvis-collaboration-retired-")); const db = new AuthorityDb(join(root, "authority.sqlite")); try { await db.migrate(); for (const sql of collaborationWriteAttempts) expect(() => db.db.prepare(sql).run()).toThrow("COLLABORATION_DEPRECATED_USE_TASK_TIMELINE"); } finally { db.close(); rmSync(root, { recursive: true, force: true }); } });
  it("publishes the immutable negative-evidence ledger bound to control authority", async () => {
    const db = new AuthorityDb(tempDb());
    await db.migrate();
    await db.migrate();
    const tables = (db.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map(row => row.name);
    expect(tables).toContain("negative_evidence");
    const columns = db.db.prepare("PRAGMA table_info(negative_evidence)").all() as Array<{ name: string; type: string; notnull: number; pk: number }>;
    expect(columns.map(column => column.name)).toEqual(["evidence_id", "task_id", "attempt_id", "reason_code", "scope_json", "summary", "evidence_digest", "request_id", "receipt_id", "created_at"]);
    expect(columns.every(column => column.type === "TEXT" && column.notnull === 1)).toBe(true);
    expect(columns.find(column => column.name === "evidence_id")?.pk).toBe(1);
    const foreignKeys = db.db.prepare("PRAGMA foreign_key_list(negative_evidence)").all() as Array<{ table: string; from: string; to: string }>;
    expect(foreignKeys).toEqual(expect.arrayContaining([
      expect.objectContaining({ table: "control_command_requests", from: "request_id", to: "request_id" }),
      expect.objectContaining({ table: "control_command_receipts", from: "receipt_id", to: "receipt_id" }),
    ]));
    const indexSql = (db.db.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND tbl_name='negative_evidence' AND sql IS NOT NULL").all() as Array<{ sql: string }>).map(row => row.sql);
    expect(indexSql.some(sql => sql.includes("(task_id,created_at,evidence_id)"))).toBe(true);
    expect(indexSql.some(sql => sql.includes("(reason_code,created_at,evidence_id)"))).toBe(true);
    const tableSql = String((db.db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='negative_evidence'").get() as { sql: string }).sql);
    expect(tableSql).toContain("invalid_assumption");
    expect(tableSql).toContain("failed_approach");
    expect(tableSql).toContain("blocked_dependency");
    expect(tableSql).toContain("verification_failure");
    expect(tableSql).toContain("external_uncertain");
    expect(tableSql).toMatch(/request_id TEXT NOT NULL UNIQUE REFERENCES control_command_requests\(request_id\)/);
    expect(tableSql).toMatch(/receipt_id TEXT NOT NULL UNIQUE REFERENCES control_command_receipts\(receipt_id\)/);
    const triggers = (db.db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name='negative_evidence'").all() as Array<{ name: string }>).map(row => row.name).sort();
    expect(triggers).toEqual(expect.arrayContaining(["negative_evidence_authority_guard", "negative_evidence_known_task_guard", "negative_evidence_immutable_delete", "negative_evidence_immutable_update"]));
    const insertRequest = db.db.prepare("INSERT INTO control_command_requests(request_id,action,action_level,target_json,args_json,command_digest,reversible,requested_by,requested_at,expires_at,nonce,state,lease_owner,lease_fence,lease_expires_at,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)");
    insertRequest.run("task:neg", "state.project", 1, "{}", "{}", "sha256:task-source", 1, "operator", "2026-08-18T00:00:00.000Z", "2026-08-18T01:00:00.000Z", "nonce-task-source", "completed", null, 0, null, "2026-08-18T00:00:00.000Z");
    const digest = `sha256:${"b".repeat(64)}`;
    const argsJson = JSON.stringify({ attempt_id: "attempt:neg", evidence_digest: digest, reason_code: "failed_approach", schema_version: 1, scope: ["scope"], summary: "bounded failure", task_id: "task:neg" });
    insertRequest.run("request:neg-schema", "evidence.negative.record", 2, "{\"environment\":\"local\",\"task_id\":\"task:neg\"}", argsJson, "sha256:neg-schema", 1, "operator", "2026-08-18T00:00:00.000Z", "2026-08-18T01:00:00.000Z", "nonce-neg-schema", "claimed", "worker", 1, "2026-08-18T01:00:00.000Z", "2026-08-18T00:00:00.000Z");
    db.db.prepare("INSERT INTO control_command_receipts(receipt_id,request_id,decision,command_digest,signer_principal_id,authenticated_session_id,key_id,payload_json,signature,issued_at,expires_at,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)").run("receipt:neg-schema", "request:neg-schema", "approve", "sha256:neg-schema", "operator", "session", "key", "{}", "sig", "2026-08-18T00:00:00.000Z", "2026-08-18T01:00:00.000Z", "2026-08-18T00:00:00.000Z");
    db.db.prepare("INSERT INTO control_command_redemptions(receipt_id,request_id,lease_fence,redeemed_at) VALUES(?,?,?,?)").run("receipt:neg-schema", "request:neg-schema", 1, "2026-08-18T00:00:00.000Z");
    const evidenceId = `sha256:${"a".repeat(64)}`;
    db.db.prepare("INSERT INTO negative_evidence(evidence_id,task_id,attempt_id,reason_code,scope_json,summary,evidence_digest,request_id,receipt_id,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)").run(evidenceId, "task:neg", "attempt:neg", "failed_approach", "[\"scope\"]", "bounded failure", digest, "request:neg-schema", "receipt:neg-schema", "2026-08-18T00:00:01.000Z");
    expect(() => db.db.prepare("UPDATE negative_evidence SET summary=? WHERE evidence_id=?").run("mutated", evidenceId)).toThrow(/immutable negative evidence/);
    expect(() => db.db.prepare("DELETE FROM negative_evidence WHERE evidence_id=?").run(evidenceId)).toThrow(/immutable negative evidence/);
    expect(() => db.db.prepare("INSERT INTO negative_evidence(evidence_id,task_id,attempt_id,reason_code,scope_json,summary,evidence_digest,request_id,receipt_id,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)").run(`sha256:${"c".repeat(64)}`, "task:neg", "attempt:neg", "not_a_reason", "[\"scope\"]", "bounded failure", digest, "request:neg-missing", "receipt:neg-schema", "2026-08-18T00:00:02.000Z")).toThrow(/CHECK constraint failed|negative evidence authority required/);
    expect((db.db.prepare("SELECT COUNT(*) AS n FROM negative_evidence").get() as { n: number }).n).toBe(1);
    expect((db.db.prepare("SELECT COUNT(*) AS n FROM schema_migrations WHERE id='028_negative_evidence.sql'").get() as { n: number }).n).toBe(1);
    db.close();
  });
});
