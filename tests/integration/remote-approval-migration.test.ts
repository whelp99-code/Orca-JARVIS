import { describe, expect, it } from "vitest";
import { AuthorityDb } from "../../src/index.js";
import { tempDb } from "../helpers.js";

describe("remote approval v2 migration", () => {
  it("applies v2 tables, quarantines legacy writes, and allows a zero counter credential", async () => {
    const db = new AuthorityDb(tempDb());
    await db.migrate();
    const tables = db.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'webauthn_%_v2' OR name='remote_owner_principals_v2'").all() as Array<{ name: string }>;
    expect(tables.map(row => row.name).sort()).toEqual(expect.arrayContaining([
      "remote_owner_principals_v2", "webauthn_credentials_v2", "webauthn_approval_challenges_v2", "webauthn_assertions_v2",
    ]));
    const quarantine = db.db.prepare("SELECT * FROM remote_auth_legacy_quarantine_v2 WHERE singleton=1").get() as {
      remote_principals_count: number; webauthn_credentials_count: number;
    };
    expect(quarantine.remote_principals_count).toBe(0);
    expect(quarantine.webauthn_credentials_count).toBe(0);
    expect(() => db.db.prepare("INSERT INTO remote_principals(principal_id,state,subject_digest,created_at) VALUES('rpr:x','absent','sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','2026-08-31T00:00:00.000Z')").run()).toThrow(/quarantined/);
    db.db.prepare(
      "INSERT INTO remote_owner_principals_v2(singleton,principal_id,user_handle,user_handle_digest,state,created_at) VALUES(1,?,?,?, 'active', ?)",
    ).run("p1", Buffer.alloc(32, 1), "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", "2026-08-31T00:00:00.000Z");
    db.db.prepare(
      `INSERT INTO webauthn_credentials_v2(
        credential_id,credential_id_digest,principal_id,public_key_cose,public_key_digest,algorithm,user_handle_digest,
        transports_json,sign_count,counter_mode,backup_eligible,backup_state,state,created_at
      ) VALUES(?,?,?,?,?,?,?,?,0,'zero',0,0,'active',?)`,
    ).run(
      "cred", "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc", "p1", "cose",
      "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd", -7,
      "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", "[]", "2026-08-31T00:00:00.000Z",
    );
    expect(db.db.prepare("SELECT sign_count FROM webauthn_credentials_v2 WHERE credential_id='cred'").get()).toEqual({ sign_count: 0 });
    expect((db.db.prepare("SELECT COUNT(*) AS n FROM schema_migrations WHERE id='056_remote_approval_v2.sql'").get() as { n: number }).n).toBe(1);
    db.close();
  });
});
