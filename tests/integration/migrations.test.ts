import { createHash } from "node:crypto"; import { appendFileSync, cpSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os"; import { join } from "node:path"; import { describe, expect, it } from "vitest";
import { AuthorityDb } from "../../src/index.js"; import { tempDb } from "../helpers.js"; const collaborationWriteAttempts = [
  `INSERT INTO collaboration_identities(
    identity_id,identity_type,display_name,public_key_pem,key_fingerprint,created_request_id,created_at
  ) VALUES('agent:old','agent','Old Agent','pem','fingerprint','request:identity','2026-08-12T00:00:00.000Z')`,
  `INSERT INTO collaboration_identity_revocations(
    revocation_id,identity_id,reason,request_id,revoked_at
  ) VALUES('revocation:identity','agent:old','retired','request:identity-revocation','2026-08-12T00:00:00.000Z')`,
  `INSERT INTO collaboration_rooms(
    room_id,room_type,name,description,visibility,created_by_identity_id,created_request_id,created_at
  ) VALUES('room:old','general','Old Room','retired','private','agent:old','request:room','2026-08-12T00:00:00.000Z')`,
  `INSERT INTO collaboration_memberships(
    membership_id,room_id,identity_id,role,permissions_json,created_request_id,joined_at
  ) VALUES('membership:old','room:old','agent:old','agent','{}','request:membership','2026-08-12T00:00:00.000Z')`,
  `INSERT INTO collaboration_membership_revocations(
    revocation_id,membership_id,reason,request_id,revoked_at
  ) VALUES('revocation:membership','membership:old','retired','request:membership-revocation','2026-08-12T00:00:00.000Z')`,
  `INSERT INTO collaboration_events(
    event_id,schema_version,room_id,event_type,author_identity_id,payload_json,payload_digest,
    approved_request_id,author_signature,created_at
  ) VALUES('event:old',1,'room:old','message','agent:old','{}','sha256:payload','request:event','signature','2026-08-12T00:00:00.000Z')`,
  `INSERT INTO collaboration_bridge_outbox(
    export_id,bridge,event_id,envelope_json,envelope_digest,state,created_request_id,created_at
  ) VALUES('export:old','buzz','event:old','{}','sha256:envelope','pending','request:bridge','2026-08-12T00:00:00.000Z')`,
]; describe("migrations", () => { it("preserves reviewed migration bytes", () => { const expected = new Map([
      ["001_authority.sql", "40968f2eb06df6cf53d65e5d2457ede191c91492df80870011e23c602fab8a59"],
      ["002_harden_authority.sql", "4ddc5e6ac9292e805ac5a727db8af580075a6aab49d7609ece7ecdd7d072cd20"],
      ["003_decision_records.sql", "db8908c1df06ecef289bc7a9d4a0c71691b08f3a5d365f13855a3f4f056c285a"],
      ["004_completion_evidence.sql", "2f501b8a0eb2b0a422f669d7047605cf1640b226edc1eaa32a46b8e6a21f297e"],
      ["005_ac2_ac4_guards.sql", "8972308fc1ea8eb44470ae512557c9546c92770ac980bd253fd19d69926f91a6"],
      ["006_sealed_anchors.sql", "cb3feae9edef107afbad7fe1ccdf56674053d8ed688b1a925fc0620b420a5e1b"],
      ["007_purposes_revocations.sql", "dba67b9c98df7f0f14babf09f79c9c022c4499c21ef4cdf2804fa4430302fcb6"],
      ["008_orca_observations.sql", "95a9f64b1af06f7149aa91c8238aab2fc2c25f912cdf87e4cdc8367ebb1beb32"],
      ["009_progress_reports.sql", "dc1a80c66b6ecab65ae14c1651a9d0e1b6f48444a1062a6f5252e38a1aa06fc9"],
      ["010_pre_gjc_shadow.sql", "54cd17ac322602fd3931d648f8811772ebdb90d0da56d00d55fc9d43752917fc"],
      ["011_live_supervisor.sql", "919014fa69e3297466441c30b77a44ed19fc27eff187f8d4303d6502338334d6"],
      ["012_live_resume_attempts.sql", "b362aa9176ba5b81f901ff0c98b65cfff1a47319eac02022e21a8c2cae3a4caa"],
      ["013_live_runtime_binding.sql", "d9d170cfcada93f109edba6eb62133fc181b1b6e829c4f77798a766fc9f8d087"],
      ["014_live_authority_hardening.sql", "b72911de818bb6f445563318199bce10d928519c86bce7aa40ecbaf82baa83f0"],
      ["015_live_policy_resume.sql", "a39c127bf027f537eac757ec87d8880d4188d780844273d7ebd8ebc25c5fd135"],
      ["016_live_report_recovery.sql", "84be422b1ec0475fb98bbca81a375104e16d0b30015c8d54a2f4c2644eb5c317"],
      ["017_gjc_runtime.sql", "1e42f22cebd205f761aad1dbd43669c347e41b939d9b1dd595534757b0f9ed07"],
      ["018_gjc_runtime_receipts.sql", "8592ef308cca94b2985f0eba85838eeab67d6e024233ffc01f56c178e304218f"],
      ["019_gjc_runtime_receipt_guards.sql", "cb21727c01c6de4af03bd534c73f7af79aacf102ce0894622a6769cbbc92a25b"],
      ["020_multi_environment_worktrees.sql", "4dd24f7629290ae668e3d03103f2be26028a431bc03c7e47c2aec737be10a2ce"],
      ["021_approval_control_plane.sql", "75ebf5cb20ab0f1a357dd55a52899cf94bf44a788a1a01c07aa3c74135942c43"],
      ["022_loopgraph_runtime.sql", "2c1fdba25a351919ab0bd4ed80e217d80754af232bf85e9f93382bf349a3529b"],
      ["023_runbook_runtime.sql", "fcb7e46da4c8ee00f1c41a37ce4092f1b130a1da7738fb7338841246dd4685e2"],
      ["024_microloop_runtime.sql", "cfb32b72fe81ee92825cbb9518e2b52985674584a2a0fb6e9e1df9f50b632cba"],
      ["025_collaboration_workspace.sql", "edcf8f85b95cf20004bf355a1e8c7f65966292f841903340bbec7d66771f3305"],
      ["026_task_timeline.sql", "cb1e19353670d180a5b27ba077e27e506d66bc532d3ead1dd7e33059ba641770"],
      ["027_control_execution_hardening.sql", "a5004fed13610811c1d7b47cf15bc3d5a02388b80f18f0cd7a2e3d0a6a1c0172"],
      ["028_negative_evidence.sql", "14330f9c41a49b4cf523352b2d3ad09809008ca820bd3b592d678dc74b6efd80"],
      ["029_budgeted_evolution_shadow.sql", "720656a278219b5571251448811b781eb951e34880014726cf18cec484a466fc"],
      ["030_dashboard_portfolio_projection.sql", "ea58ca0a324793af837be8a179dd4a7b700943d5a6a8a0b0d765d065dcc24482"],
      ["031_control_ingress_idempotency.sql", "aa936566bcdec1b6d4823082d71f5e289e5b9a072a8936f78000678f57d9cd1f"],
      ["032_personal_context.sql", "a419b923fa3c2dfe6f957199256ad3ad5e5601e2fd60e0ba3ea5d3b7277c841b"],
      ["033_personal_operations.sql", "33e2755a78d87d281bfd3bfe7b18aed07ee3b93216f5131c4453329f169596b4"],
      ["034_recommendation_transition_identity.sql", "80a6ecaa8adf7e0f21fa6cee34950a69972ea8802ac5ac0f035e129c4bb67109"],
      ["035_daily_loop_durable_guards.sql", "5e8be32e037f0fa87a6139da97b883fd343dce98469d0fecd456009bae641fef"],
      ["036_notification_intent_immutable_delete.sql", "a36ba7cecf63f28cc9fa7f6be6ce9aed0e7e093681d754fb1e897605b807aeb2"],
      ["037_recommendation_work_runtime.sql", "a231ce3f25b7e7bd495dc3b24a40cd826c761d85f75524d495ff9e060f51645b"],
      ["038_memory_candidate_classification.sql", "087f24c6462331e6d720304b86b2f90bdf761473c201b306e4db9f301072241f"],
      ["039_memory_outbox_saga.sql", "308a112b4af5500e00b68b6c1ab8b88b5e38b096b62e5233a918a1649b0f3d69"],
      ["040_memory_tombstone_authority.sql", "3a28ed5184b14653afc837642103e3680af8a1986548264991bf16e4c20364d2"],
      ["041_memory_correction_saga.sql", "8a885d47d89dd15d8b4087e51e06aa957a94e815a4babc48a01f28b497bc7acf"],
      ["042_memory_deletion_proof.sql", "d9b2805bca5ae5bbede25f4974a703d60f0016b9e1b03001264bb4b083b99319"],
      ["043_memory_export_saga.sql", "c6d4b54c278159de006cc4c11a0ff2f97b3733fb7688b19b541cab726260a742"],
      ["044_memory_content_propagation.sql", "ed178096f900b41262534fa422e7e0f0e7c9f91a8d2ba68381177810c6ef0f17"], ]); expect(expected.size).toBe(44);
    for (const [name, checksum] of expected) { const source = readFileSync(join(process.cwd(), "migrations", name));
      expect(createHash("sha256").update(source).digest("hex"), name).toBe(checksum); } });
  it("applies every immutable forward migration repeatedly", async () => { const db = new AuthorityDb(tempDb()); await db.migrate(); await db.migrate();
    const expected = readdirSync(join(process.cwd(), "migrations")).filter((file) => file.endsWith(".sql")).length;
    expect((db.db.prepare("SELECT COUNT(*) AS n FROM schema_migrations").get() as { n: number }).n).toBe(expected); });
  it("applies personal context between 031 and 033 on empty and exact prior-031 databases", async () => {
    // Given isolated full and prior-031 migration directories
    const source = join(process.cwd(), "migrations"); const full = join(mkdtempSync(join(tmpdir(), "jarvis-context-full-")), "migrations");
    const prior = join(mkdtempSync(join(tmpdir(), "jarvis-context-prior-")), "migrations"); cpSync(source, full, { recursive: true });
    cpSync(source, prior, { recursive: true });
    for (const file of readdirSync(prior)) if (file > "031_control_ingress_idempotency.sql") rmSync(join(prior, file));
    const empty = new AuthorityDb(tempDb(), full); const upgraded = new AuthorityDb(tempDb(), prior); try { await upgraded.migrate();
      // When the exact 032 and later migrations become available
      for (const file of readdirSync(full)) if (file >= "032_personal_context.sql") cpSync(join(full, file), join(prior, file)); await empty.migrate();
      await upgraded.migrate();
      // Then both journals preserve unique checksummed order through independent slot 038.
      for (const db of [empty, upgraded]) {
        const rows = db.db.prepare("SELECT id,checksum FROM schema_migrations WHERE id>='031_' ORDER BY id").all() as Array<{ id: string; checksum: string }>;
        expect(rows.map((row) => row.id)).toEqual([ "031_control_ingress_idempotency.sql", "032_personal_context.sql", "033_personal_operations.sql",
          "034_recommendation_transition_identity.sql", "035_daily_loop_durable_guards.sql", "036_notification_intent_immutable_delete.sql",
          "037_recommendation_work_runtime.sql", "038_memory_candidate_classification.sql", "039_memory_outbox_saga.sql", "040_memory_tombstone_authority.sql",
          "041_memory_correction_saga.sql", "042_memory_deletion_proof.sql", "043_memory_export_saga.sql", "044_memory_content_propagation.sql",
          "045_task30_schema_compatibility.sql", "046_task30_legacy_guards.sql",
          "047_task30_confirmation_compatibility.sql", ]);
        expect(new Set(rows.map((row) => row.checksum)).size).toBe(rows.length); } } finally { empty.close(); upgraded.close();
      rmSync(join(full, ".."), { recursive: true, force: true }); rmSync(join(prior, ".."), { recursive: true, force: true }); } });
  it("fails closed when migration is pending or its raw SQL bytes change", async () => { const pending = new AuthorityDb(tempDb());
    await expect(pending.assertMigrationsReady()).rejects.toMatchObject({ code: "MIGRATIONS_PENDING" });
    const directory = join(mkdtempSync(join(tmpdir(), "jarvis-migrations-")), "migrations");
    cpSync(join(process.cwd(), "migrations"), directory, { recursive: true }); const db = new AuthorityDb(tempDb(), directory); await db.migrate();
    appendFileSync(join(directory, "002_harden_authority.sql"), "\n-- byte change\n");
    await expect(db.assertMigrationsReady()).rejects.toMatchObject({ code: "MIGRATION_CHECKSUM_MISMATCH" }); });
  it("publishes the forward execution-hardening schema", async () => { const db = new AuthorityDb(tempDb()); await db.migrate();
    const tables = (db.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map((row) => row.name);
    expect(tables).toEqual(expect.arrayContaining(["control_command_revocations", "control_effect_attempts", "workflow_step_approvals"]));
    const attemptColumns = (db.db.prepare("PRAGMA table_info(control_effect_attempts)").all() as Array<{ name: string }>).map((row) => row.name);
    expect(attemptColumns).toEqual(expect.arrayContaining(["idempotency_key", "state", "receipt_json", "receipt_digest", "error_code"]));
    const approvalColumns = (db.db.prepare("PRAGMA table_info(workflow_step_approvals)").all() as Array<{ name: string }>).map((row) => row.name);
    expect(approvalColumns).toContain("lease_fence"); db.close(); }); it("rejects every retired collaboration write on a fresh migrated database", async () => {
    const root = mkdtempSync(join(tmpdir(), "jarvis-collaboration-retired-")); const db = new AuthorityDb(join(root, "authority.sqlite")); try {
      await db.migrate();
      for (const sql of collaborationWriteAttempts) expect(() => db.db.prepare(sql).run()).toThrow("COLLABORATION_DEPRECATED_USE_TASK_TIMELINE"); } finally {
      db.close(); rmSync(root, { recursive: true, force: true }); } });
  it("publishes the immutable negative-evidence ledger bound to control authority", async () => { const db = new AuthorityDb(tempDb()); await db.migrate();
    await db.migrate();
    const tables = (db.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map((row) => row.name);
    expect(tables).toContain("negative_evidence");
    const columns = db.db.prepare("PRAGMA table_info(negative_evidence)").all() as Array<{ name: string; type: string; notnull: number; pk: number }>;
    expect(columns.map((column) => column.name)).toEqual([ "evidence_id", "task_id", "attempt_id", "reason_code", "scope_json", "summary", "evidence_digest",
      "request_id", "receipt_id", "created_at", ]); expect(columns.every((column) => column.type === "TEXT" && column.notnull === 1)).toBe(true);
    expect(columns.find((column) => column.name === "evidence_id")?.pk).toBe(1);
    const foreignKeys = db.db.prepare("PRAGMA foreign_key_list(negative_evidence)").all() as Array<{ table: string; from: string; to: string }>;
    expect(foreignKeys).toEqual( expect.arrayContaining([ expect.objectContaining({ table: "control_command_requests", from: "request_id", to: "request_id" }),
        expect.objectContaining({ table: "control_command_receipts", from: "receipt_id", to: "receipt_id" }), ]), ); const indexSql = (
      db.db.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND tbl_name='negative_evidence' AND sql IS NOT NULL").all() as Array<{ sql: string }>
    ).map((row) => row.sql); expect(indexSql.some((sql) => sql.includes("(task_id,created_at,evidence_id)"))).toBe(true);
    expect(indexSql.some((sql) => sql.includes("(reason_code,created_at,evidence_id)"))).toBe(true);
    const tableSql = String((db.db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='negative_evidence'").get() as { sql: string }).sql);
    expect(tableSql).toContain("invalid_assumption"); expect(tableSql).toContain("failed_approach"); expect(tableSql).toContain("blocked_dependency");
    expect(tableSql).toContain("verification_failure"); expect(tableSql).toContain("external_uncertain");
    expect(tableSql).toMatch(/request_id TEXT NOT NULL UNIQUE REFERENCES control_command_requests\(request_id\)/);
    expect(tableSql).toMatch(/receipt_id TEXT NOT NULL UNIQUE REFERENCES control_command_receipts\(receipt_id\)/);
    const triggers = (db.db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name='negative_evidence'").all() as Array<{ name: string }>)
      .map((row) => row.name) .sort(); expect(triggers).toEqual( expect.arrayContaining([ "negative_evidence_authority_guard",
        "negative_evidence_known_task_guard", "negative_evidence_immutable_delete", "negative_evidence_immutable_update", ]), );
    const insertRequest = db.db.prepare(
      `INSERT INTO control_command_requests(
        request_id,action,action_level,target_json,args_json,command_digest,reversible,requested_by,
        requested_at,expires_at,nonce,state,lease_owner,lease_fence,lease_expires_at,created_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ); insertRequest.run( "task:neg", "state.project", 1, "{}", "{}", "sha256:task-source", 1, "operator", "2026-08-18T00:00:00.000Z",
      "2026-08-18T01:00:00.000Z", "nonce-task-source", "completed", null, 0, null, "2026-08-18T00:00:00.000Z", ); const digest = `sha256:${"b".repeat(64)}`;
    const argsJson = JSON.stringify({ attempt_id: "attempt:neg", evidence_digest: digest, reason_code: "failed_approach", schema_version: 1, scope: ["scope"],
      summary: "bounded failure", task_id: "task:neg", }); insertRequest.run( "request:neg-schema", "evidence.negative.record", 2,
      '{"environment":"local","task_id":"task:neg"}', argsJson, "sha256:neg-schema", 1, "operator", "2026-08-18T00:00:00.000Z", "2026-08-18T01:00:00.000Z",
      "nonce-neg-schema", "claimed", "worker", 1, "2026-08-18T01:00:00.000Z", "2026-08-18T00:00:00.000Z", ); db.db .prepare(
        `INSERT INTO control_command_receipts(
          receipt_id,request_id,decision,command_digest,signer_principal_id,authenticated_session_id,
          key_id,payload_json,signature,issued_at,expires_at,created_at
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
      ) .run( "receipt:neg-schema", "request:neg-schema", "approve", "sha256:neg-schema", "operator", "session", "key", "{}", "sig", "2026-08-18T00:00:00.000Z",
        "2026-08-18T01:00:00.000Z", "2026-08-18T00:00:00.000Z", ); db.db
      .prepare("INSERT INTO control_command_redemptions(receipt_id,request_id,lease_fence,redeemed_at) VALUES(?,?,?,?)")
      .run("receipt:neg-schema", "request:neg-schema", 1, "2026-08-18T00:00:00.000Z"); const evidenceId = `sha256:${"a".repeat(64)}`; db.db .prepare(
        `INSERT INTO negative_evidence(
          evidence_id,task_id,attempt_id,reason_code,scope_json,summary,evidence_digest,
          request_id,receipt_id,created_at
        ) VALUES(?,?,?,?,?,?,?,?,?,?)`,
      ) .run( evidenceId, "task:neg", "attempt:neg", "failed_approach", '["scope"]', "bounded failure", digest, "request:neg-schema", "receipt:neg-schema",
        "2026-08-18T00:00:01.000Z", );
    expect(() => db.db.prepare("UPDATE negative_evidence SET summary=? WHERE evidence_id=?").run("mutated", evidenceId)).toThrow(/immutable negative evidence/);
    expect(() => db.db.prepare("DELETE FROM negative_evidence WHERE evidence_id=?").run(evidenceId)).toThrow(/immutable negative evidence/); expect(() => db.db
        .prepare(
          `INSERT INTO negative_evidence(
            evidence_id,task_id,attempt_id,reason_code,scope_json,summary,evidence_digest,
            request_id,receipt_id,created_at
          ) VALUES(?,?,?,?,?,?,?,?,?,?)`,
        ) .run( `sha256:${"c".repeat(64)}`, "task:neg", "attempt:neg", "not_a_reason", '["scope"]', "bounded failure", digest, "request:neg-missing",
          "receipt:neg-schema", "2026-08-18T00:00:02.000Z", ), ).toThrow(/CHECK constraint failed|negative evidence authority required/);
    expect((db.db.prepare("SELECT COUNT(*) AS n FROM negative_evidence").get() as { n: number }).n).toBe(1);
    expect((db.db.prepare("SELECT COUNT(*) AS n FROM schema_migrations WHERE id='028_negative_evidence.sql'").get() as { n: number }).n).toBe(1); db.close();
  }); });
