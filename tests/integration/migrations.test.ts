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
  it("preserves the shipped migration 021 through 026 bytes", () => {
    const expected = new Map([
      ["021_approval_control_plane.sql", "75ebf5cb20ab0f1a357dd55a52899cf94bf44a788a1a01c07aa3c74135942c43"],
      ["022_loopgraph_runtime.sql", "2c1fdba25a351919ab0bd4ed80e217d80754af232bf85e9f93382bf349a3529b"],
      ["023_runbook_runtime.sql", "fcb7e46da4c8ee00f1c41a37ce4092f1b130a1da7738fb7338841246dd4685e2"],
      ["024_microloop_runtime.sql", "cfb32b72fe81ee92825cbb9518e2b52985674584a2a0fb6e9e1df9f50b632cba"],
      ["025_collaboration_workspace.sql", "edcf8f85b95cf20004bf355a1e8c7f65966292f841903340bbec7d66771f3305"],
      ["026_task_timeline.sql", "cb1e19353670d180a5b27ba077e27e506d66bc532d3ead1dd7e33059ba641770"],
    ]);

    for (const [name, checksum] of expected) {
      const source = readFileSync(join(process.cwd(), "migrations", name));
      expect(createHash("sha256").update(source).digest("hex"), name).toBe(checksum);
    }
  });

  it("applies every immutable forward migration repeatedly", async () => { const db = new AuthorityDb(tempDb()); await db.migrate(); await db.migrate(); const expected = readdirSync(join(process.cwd(), "migrations")).filter(file => file.endsWith(".sql")).length; expect((db.db.prepare("SELECT COUNT(*) AS n FROM schema_migrations").get() as { n: number }).n).toBe(expected); });
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
});
