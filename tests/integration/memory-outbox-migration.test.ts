import { createHash } from "node:crypto";
import { cpSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AuthorityDb } from "../../src/index.js";
import { digest, T0, T1, T5 } from "./personal-operations-test-helpers.js";

const SLOT = "039_memory_outbox_saga.sql";
const validMappings = [
  ["queued", "queued"], ["delivering", "reconciling"],
  ["accepted_unsettled", "reconciling"], ["uncertain", "reconciling"],
  ["rejected", "failed"], ["expired", "expired"], ["settled", "settled"],
] as const;
const invalidStates = ["proposed", "classified", "awaiting_confirmation", "approved"] as const;
function migrationRoot(): { root: string; migrations: string; database: string } {
  const root = mkdtempSync(join(tmpdir(), "task29-migration-")); const migrations = join(root, "migrations");
  cpSync(join(process.cwd(), "migrations"), migrations, { recursive: true });
  for (const name of readdirSync(migrations)) if (name >= SLOT) rmSync(join(migrations, name));
  return { root, migrations, database: join(root, "authority.sqlite") };
}
function seedCandidate(db: AuthorityDb, suffix: string, operation = "remember"): string {
  const id = `memcand:${suffix}`;
  db.db.prepare(
    `INSERT INTO memory_candidates(
      candidate_id,correlation_id,idempotency_key,candidate_kind,operation,subject_digest,content_digest,
      source_digest,sensitivity,purpose,required_confirmation,state,expires_at,created_at,updated_at
     ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(id, `corr:${suffix}`, `idem:candidate:${suffix}`, "verified_fact", operation, digest("1"),
    digest("2"), digest("3"), "normal", "continuity", 0, "proposed", T5, T0, T0);
  return id;
}
function dropLegacyGuards(db: AuthorityDb): readonly string[] {
  const names = ["memory_outbox_candidate_guard", "memory_outbox_queue_candidate",
    "memory_outbox_transition", "memory_outbox_attempt_guard", "memory_reconciliation_fence_guard"];
  const sql = names.map(name => (db.db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name=?").get(name) as { sql: string }).sql);
  for (const name of names) db.db.exec(`DROP TRIGGER ${name}`);
  return sql;
}
function restoreLegacyGuards(db: AuthorityDb, sql: readonly string[]): void { for (const value of sql) db.db.exec(value); }
function seedLegacy(db: AuthorityDb, suffix: string, state: string, operation = "remember", observed = true): void {
  const candidate = seedCandidate(db, suffix, operation);
  db.db.prepare(
    `INSERT INTO memory_outbox(
      outbox_id,candidate_id,idempotency_key,operation,request_digest,expected_artifact_digest,
      state,lease_owner,lease_fence,lease_expires_at,expires_at,settled_at,created_at,updated_at
     ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(`memout:${suffix}`, candidate, `idem:outbox:${suffix}`, operation,
    `sha256:${createHash("sha256").update(suffix).digest("hex")}`, digest("5"), state,
    state === "delivering" ? "legacy-worker" : null,
    state === "queued" || state === "rejected" || state === "expired" ? 0 : 1,
    state === "delivering" ? T5 : null, T5, state === "settled" ? T1 : null, T0, T1);
  if (state === "settled" && observed) db.db.prepare(
    `INSERT INTO memory_reconciliation_events(
      event_id,outbox_id,lease_fence,event_type,observed_artifact_digest,effect_digest,created_at
     ) VALUES(?,?,?,?,?,?,?)`,
  ).run(`event:${suffix}`, `memout:${suffix}`, 1, "artifact_observed", digest("5"), digest("6"), T1);
}
function schema(db: AuthorityDb): readonly { type: string; name: string; sql: string }[] {
  return db.db.prepare(
    `SELECT type,name,sql FROM sqlite_master WHERE name LIKE 'memory_outbox%'
      OR name LIKE 'memory_reconciliation%' ORDER BY type,name`,
  ).all() as Array<{ type: string; name: string; sql: string }>;
}
async function applySlot(value: ReturnType<typeof migrationRoot>, db: AuthorityDb): Promise<void> {
  db.close();
  for (const name of readdirSync(join(process.cwd(), "migrations"))) {
    if (name >= SLOT) cpSync(join(process.cwd(), "migrations", name), join(value.migrations, name));
  }
  const upgraded = new AuthorityDb(value.database, value.migrations);
  try { await upgraded.migrate(); } finally { upgraded.close(); }
}

describe("memory outbox V2 forward migration", () => {
  it("publishes only closed V2 machine values and exact fence columns", async () => {
    const db = new AuthorityDb(join(mkdtempSync(join(tmpdir(), "task29-fresh-")), "authority.sqlite"));
    try {
      await db.migrate(); const outbox = String((db.db.prepare("SELECT sql FROM sqlite_master WHERE name='memory_outbox'").get() as { sql: string }).sql);
      const attempts = String((db.db.prepare("SELECT sql FROM sqlite_master WHERE name='memory_outbox_attempts'").get() as { sql: string }).sql);
      const events = String((db.db.prepare("SELECT sql FROM sqlite_master WHERE name='memory_reconciliation_events'").get() as { sql: string }).sql);
      for (const state of ["queued", "claimed", "dispatching", "reconciling", "settled", "conflict", "failed", "expired"]) expect(outbox).toContain(`'${state}'`);
      for (const legacy of ["delivering", "accepted_unsettled", "uncertain", "rejected", "forget", "export"]) expect(outbox).not.toContain(`'${legacy}'`);
      expect(attempts).toContain("'dispatching','accepted','uncertain'"); expect(attempts).not.toContain("'rejected'");
      expect(attempts).not.toContain("lease_fence"); expect(events).toContain("reconcile_fence"); expect(events).not.toContain("lease_fence");
    } finally { const root = join(db.filename, ".."); db.close(); rmSync(root, { recursive: true, force: true }); }
  });

  it("maps every valid legacy state and produces the fresh schema exactly", async () => {
    const value = migrationRoot(); const prior = new AuthorityDb(value.database, value.migrations);
    try {
      await prior.migrate(); const guards = dropLegacyGuards(prior);
      for (const [state] of validMappings) seedLegacy(prior, state, state);
      restoreLegacyGuards(prior, guards); await applySlot(value, prior);
      const upgraded = new AuthorityDb(value.database, value.migrations); const freshRoot = mkdtempSync(join(tmpdir(), "task29-fresh-schema-"));
      const fresh = new AuthorityDb(join(freshRoot, "authority.sqlite"));
      try {
        await fresh.migrate();
        expect(schema(upgraded)).toEqual(schema(fresh));
        const rows = upgraded.db.prepare("SELECT outbox_id,state FROM memory_outbox ORDER BY outbox_id").all() as Array<{ outbox_id: string; state: string }>;
        expect(rows.map(row => [row.outbox_id.slice(7), row.state])).toEqual([...validMappings].sort((a, b) => a[0].localeCompare(b[0])));
      } finally { upgraded.close(); fresh.close(); rmSync(freshRoot, { recursive: true, force: true }); }
    } finally { rmSync(value.root, { recursive: true, force: true }); }
  });

  it.each([...invalidStates, "forget", "export", "settled_without_observation"])("aborts invalid legacy lane %s", async lane => {
    const value = migrationRoot(); const prior = new AuthorityDb(value.database, value.migrations);
    try {
      await prior.migrate(); const guards = dropLegacyGuards(prior);
      const state = lane === "settled_without_observation" ? "settled" : invalidStates.includes(lane as typeof invalidStates[number]) ? lane : "queued";
      seedLegacy(prior, lane, state, lane === "forget" || lane === "export" ? lane : "remember",
        lane !== "settled_without_observation");
      restoreLegacyGuards(prior, guards); prior.close();
      for (const name of readdirSync(join(process.cwd(), "migrations"))) {
        if (name >= SLOT) cpSync(join(process.cwd(), "migrations", name), join(value.migrations, name));
      }
      const upgraded = new AuthorityDb(value.database, value.migrations);
      try { await expect(upgraded.migrate()).rejects.toThrow("MEMORY_OUTBOX_MIGRATION_INVALID"); }
      finally { upgraded.close(); }
    } finally { rmSync(value.root, { recursive: true, force: true }); }
  });
});
