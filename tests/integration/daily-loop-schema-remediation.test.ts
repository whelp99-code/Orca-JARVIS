import { createHash } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AuthorityDb, DailyControlLoop, DailyLoopStore, canonicalize } from "../../src/index.js";

const T0 = "2026-08-28T00:00:00.000Z";
const T1 = "2026-08-28T00:01:00.000Z";
const T2 = "2026-08-28T00:02:00.000Z";
const T4 = "2026-08-28T00:04:00.000Z";
const T5 = "2026-08-28T00:05:00.000Z";
const sha = (value: string): string => `sha256:${createHash("sha256").update(value).digest("hex")}`;

const migrationRoot = (through035: boolean): { readonly root: string; readonly migrations: string; readonly path: string } => {
  const root = mkdtempSync(join(tmpdir(), "task20-schema-"));
  const migrations = join(root, "migrations"); cpSync(join(process.cwd(), "migrations"), migrations, { recursive: true });
  const upperBound = through035 ? "035_daily_loop_durable_guards.sql" : "034_recommendation_transition_identity.sql";
  for (const file of readdirSync(migrations)) {
    if (file.endsWith(".sql") && file > upperBound) rmSync(join(migrations, file));
  }
  return { root, migrations, path: join(root, "authority.sqlite") };
};
const insertLegacy = (db: AuthorityDb, id: string, state: "pending" | "claimed" | "running" | "completed" | "failed" | "uncertain"): void => {
  db.db.prepare("INSERT INTO daily_loop_runs(run_id,loop_date,correlation_id,idempotency_key,state,lease_fence,expires_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)")
    .run(`dlr:${id}`, "2026-08-28", `corr:${id}`, `idem:${id}`, "pending", 0, T5, T0, T0);
  if (state === "pending") return;
  if (state === "failed") { db.db.prepare("UPDATE daily_loop_runs SET state='failed',failure_code='MISSED_RECOVERY_WINDOW',updated_at=? WHERE run_id=?").run(T1, `dlr:${id}`); return; }
  db.db.prepare("UPDATE daily_loop_runs SET state='claimed',lease_owner='legacy',lease_fence=1,lease_expires_at=?,updated_at=? WHERE run_id=?").run(T4, T1, `dlr:${id}`);
  if (state === "claimed") return;
  if (state === "uncertain") { db.db.prepare("UPDATE daily_loop_runs SET state='uncertain',failure_code='legacy_uncertain',lease_owner=NULL,lease_expires_at=NULL,updated_at=? WHERE run_id=?").run(T1, `dlr:${id}`); return; }
  db.db.prepare("UPDATE daily_loop_runs SET state='running',updated_at=? WHERE run_id=?").run(T1, `dlr:${id}`);
  if (state === "running") return;
  db.db.prepare("UPDATE daily_loop_runs SET state='verifying',updated_at=? WHERE run_id=?").run(T1, `dlr:${id}`);
  db.db.prepare("UPDATE daily_loop_runs SET state='completed',result_digest=?,lease_owner=NULL,lease_expires_at=NULL,updated_at=? WHERE run_id=?").run(sha(id), T1, `dlr:${id}`);
};
const legacyCheckpoint = (db: AuthorityDb, run: string, id: string, sequence: number, previous: string | null, fence = 1, lease = T4, step: string | null = null): string => {
  const digest = sha(id);
  db.db.prepare("INSERT INTO daily_loop_checkpoints(checkpoint_id,run_id,step_id,sequence,state,previous_digest,checkpoint_digest,lease_fence,lease_expires_at,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)")
    .run(`dlc:${id}`, run, step, sequence, "running", previous, digest, fence, lease, T1);
  return digest;
};
const loopOptions = (clock: () => Date, owner = "linux:a") => ({
  time_zone: "Asia/Seoul" as const, owner_id: owner, lease_ms: 1_000, deadline_ms: 60_000,
  recovery_window_ms: 86_400_000, recovery_lookback_days: 2, refresh_freshness_ms: 60_000,
  budgets: { max_items: 8, max_work: 8, max_bytes: 4096 }, clock,
  event_source: { drain: () => [] }, refresh_reader: { read: () => null },
});

describe("migration 035 upgrade integrity", () => {
  it("resumes a legacy verifying run without replaying its verification checkpoint", async () => {
    const fixture = migrationRoot(false); const db = new AuthorityDb(fixture.path, fixture.migrations);
    try {
      await db.migrate(); insertLegacy(db, "verifying", "running");
      db.db.prepare("INSERT INTO daily_loop_steps(step_id,run_id,sequence,step_key,state,created_at,updated_at) VALUES('dls:done','dlr:verifying',1,'legacy-step','pending',?,?)")
        .run(T0, T0);
      db.db.prepare("UPDATE daily_loop_steps SET state='claimed',evidence_digest=? WHERE step_id='dls:done'").run(sha("evidence"));
      for (const state of ["running", "verifying"]) db.db.prepare("UPDATE daily_loop_steps SET state=? WHERE step_id='dls:done'").run(state);
      db.db.prepare("UPDATE daily_loop_steps SET state='completed',result_digest=? WHERE step_id='dls:done'").run(sha("step-result"));
      db.db.prepare("INSERT INTO daily_loop_checkpoints(checkpoint_id,run_id,sequence,state,checkpoint_digest,lease_fence,lease_expires_at,created_at) VALUES('dlc:verified','dlr:verifying',1,'verifying',?,1,?,?)")
        .run(sha("verified"), T4, T1);
      db.db.prepare("UPDATE daily_loop_runs SET state='verifying',updated_at=? WHERE run_id='dlr:verifying'").run(T1);
      cpSync(join(process.cwd(), "migrations"), fixture.migrations, { recursive: true }); await db.migrate();
      const savedStep = db.db.prepare("SELECT * FROM daily_loop_steps").get();
      const savedCheckpoint = db.db.prepare("SELECT * FROM daily_loop_checkpoints").get();
      const loop = new DailyControlLoop(new DailyLoopStore(db), loopOptions(() => new Date(T4)));
      expect((await loop.cycle()).completed_run_ids).toEqual(["dlr:verifying"]);
      expect(db.db.prepare("SELECT state,lease_fence FROM daily_loop_runs").get()).toEqual({ state: "completed", lease_fence: 2 });
      expect(db.db.prepare("SELECT * FROM daily_loop_steps").get()).toEqual(savedStep);
      expect(db.db.prepare("SELECT * FROM daily_loop_checkpoints WHERE sequence=1").get()).toEqual(savedCheckpoint);
      expect(db.db.prepare("SELECT state,lease_fence,previous_digest FROM daily_loop_checkpoints WHERE sequence=2").get())
        .toEqual({ state: "completed", lease_fence: 2, previous_digest: sha("verified") });
    } finally { db.close(); rmSync(fixture.root, { recursive: true, force: true }); }
  });

  it("upgrades six valid legacy lifecycle shapes byte-identically and continues with version one", async () => {
    // Given
    const fixture = migrationRoot(false); const db = new AuthorityDb(fixture.path, fixture.migrations);
    try {
      await db.migrate();
      for (const state of ["pending", "claimed", "running", "completed", "failed", "uncertain"] as const) insertLegacy(db, state, state);
      db.db.prepare("INSERT INTO daily_loop_steps(step_id,run_id,sequence,step_key,state,created_at,updated_at) VALUES('dls:partial','dlr:running',1,'legacy-step','pending',?,?)").run(T0, T0);
      legacyCheckpoint(db, "dlr:running", "partial", 1, null);
      const before = sha(canonicalize(db.db.prepare("SELECT run_id,loop_date,correlation_id,idempotency_key,state,lease_owner,lease_fence,lease_expires_at,expires_at,result_digest,failure_code,created_at,updated_at FROM daily_loop_runs ORDER BY run_id").all()));
      cpSync(join(process.cwd(), "migrations", "035_daily_loop_durable_guards.sql"), join(fixture.migrations, "035_daily_loop_durable_guards.sql"));

      // When
      await db.migrate(); const objects = db.db.prepare("SELECT count(*) AS n FROM sqlite_master").get() as { n: number }; await db.migrate();

      // Then
      expect(sha(canonicalize(db.db.prepare("SELECT run_id,loop_date,correlation_id,idempotency_key,state,lease_owner,lease_fence,lease_expires_at,expires_at,result_digest,failure_code,created_at,updated_at FROM daily_loop_runs ORDER BY run_id").all()))).toBe(before);
      expect(db.db.prepare("SELECT record_version,count(*) AS n FROM daily_loop_runs GROUP BY record_version").all()).toEqual([{ record_version: 0, n: 6 }]);
      expect(db.db.prepare("SELECT legacy_run_count,legacy_step_count,legacy_checkpoint_count,invalid_checkpoint_count FROM daily_loop_migration_035_evidence").get()).toEqual({ legacy_run_count: 6, legacy_step_count: 1, legacy_checkpoint_count: 1, invalid_checkpoint_count: 0 });
      expect((db.db.prepare("SELECT count(*) AS n FROM sqlite_master").get() as { n: number }).n).toBe(objects.n);
      const at = new Date("2026-08-31T03:00:00.000Z"); const loop = new DailyControlLoop(new DailyLoopStore(db), loopOptions(() => at));
      const event = { kind: "event", event_id: "continuation", occurred_at: at.toISOString(), critical: false, items: 1, work: 1, bytes: 1 };
      // Historical 035 assertions above stay isolated. Current event preparation requires 075.
      const legacyRows = db.db.prepare("SELECT * FROM daily_loop_runs ORDER BY run_id").all();
      expect(() => loop.prepare(event)).toThrow("DAILY_LOOP_IDENTITY_CONFLICT");
      expect(db.db.prepare("SELECT * FROM daily_loop_runs ORDER BY run_id").all()).toEqual(legacyRows);
      cpSync(join(process.cwd(), "migrations"), fixture.migrations, { recursive: true }); await db.migrate();
      expect(db.db.prepare("SELECT * FROM daily_loop_runs ORDER BY run_id").all()).toEqual(legacyRows);
      const prepared = loop.prepare(event);
      if (prepared.kind !== "prepared") throw new Error("continuation not prepared"); loop.finish(loop.claim(prepared.run_id));
      expect(db.db.prepare("SELECT state,record_version FROM daily_loop_runs WHERE run_id=?").get(prepared.run_id)).toEqual({ state: "completed", record_version: 1 });
    } finally { db.close(); rmSync(fixture.root, { recursive: true, force: true }); }
  });

  it("continues pending, expired claimed, and running partial v0 rows with an opaque tail", async () => {
    // Given
    const fixture = migrationRoot(false); const db = new AuthorityDb(fixture.path, fixture.migrations);
    try {
      await db.migrate();
      for (const id of ["pending", "claimed", "partial"]) db.db.prepare("INSERT INTO daily_loop_runs(run_id,loop_date,correlation_id,idempotency_key,state,lease_fence,expires_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)").run(`dlr:${id}`, "2026-08-28", `corr:${id}`, `idem:${id}`, "pending", 0, T5, T0, T0);
      db.db.prepare("INSERT INTO daily_loop_steps(step_id,run_id,sequence,step_key,state,created_at,updated_at) VALUES('dls:pending','dlr:pending',1,'pending-step','pending',?,?)").run(T0, T0);
      for (const id of ["claimed", "partial"]) db.db.prepare("UPDATE daily_loop_runs SET state='claimed',lease_owner='legacy',lease_fence=1,lease_expires_at=?,updated_at=? WHERE run_id=?").run(T2, T1, `dlr:${id}`);
      db.db.prepare("UPDATE daily_loop_runs SET state='running',updated_at=? WHERE run_id='dlr:partial'").run(T1);
      db.db.prepare("INSERT INTO daily_loop_steps(step_id,run_id,sequence,step_key,state,evidence_digest,created_at,updated_at) VALUES('dls:partial','dlr:partial',1,'partial-step','pending',NULL,?,?)").run(T0, T0);
      db.db.prepare("UPDATE daily_loop_steps SET state='claimed',evidence_digest=? WHERE step_id='dls:partial'").run(sha("opaque-evidence"));
      const opaque = legacyCheckpoint(db, "dlr:partial", "opaque-tail", 1, null, 1, T2, "dls:partial");
      cpSync(join(process.cwd(), "migrations", "035_daily_loop_durable_guards.sql"), join(fixture.migrations, "035_daily_loop_durable_guards.sql")); await db.migrate();
      const store = new DailyLoopStore(db); const at = new Date(T2);

      // When
      expect(store.due(at)).toContain("dlr:pending");
      for (const id of ["pending", "claimed", "partial"]) { const claim = store.claim({ run_id: `dlr:${id}`, owner_id: "current", at, lease_ms: 120_000 }); const loop = new DailyControlLoop(store, loopOptions(() => at, "current")); loop.finish(claim); }

      // Then
      expect(db.db.prepare("SELECT run_id,state,record_version FROM daily_loop_runs WHERE run_id LIKE 'dlr:%' ORDER BY run_id").all()).toEqual([
        { run_id: "dlr:claimed", state: "completed", record_version: 0 }, { run_id: "dlr:partial", state: "completed", record_version: 0 }, { run_id: "dlr:pending", state: "completed", record_version: 0 },
      ]);
      expect(db.db.prepare("SELECT previous_digest FROM daily_loop_checkpoints WHERE run_id='dlr:partial' AND record_version=1 ORDER BY sequence LIMIT 1").get()).toEqual({ previous_digest: opaque });
      const reopened = new AuthorityDb(fixture.path, fixture.migrations); expect(reopened.db.prepare("SELECT count(*) AS n FROM daily_loop_checkpoints c WHERE c.record_version=1 AND c.sequence>1 AND NOT EXISTS(SELECT 1 FROM daily_loop_checkpoints p WHERE p.run_id=c.run_id AND p.sequence=c.sequence-1 AND p.checkpoint_digest=c.previous_digest)").get()).toEqual({ n: 0 }); reopened.close();
    } finally { db.close(); rmSync(fixture.root, { recursive: true, force: true }); }
  });

  it.each(["fence999", "gap", "wrong_predecessor", "cross_run_step", "expired_snapshot"])("rolls back corrupt legacy %s without a 035 journal or object", async corruption => {
    // Given
    const fixture = migrationRoot(false); const db = new AuthorityDb(fixture.path, fixture.migrations);
    try {
      await db.migrate(); insertLegacy(db, "a", "claimed"); insertLegacy(db, "b", "claimed");
      if (corruption === "fence999") legacyCheckpoint(db, "dlr:a", "bad", 1, null, 999);
      if (corruption === "gap") legacyCheckpoint(db, "dlr:a", "gap", 2, sha("missing"));
      if (corruption === "wrong_predecessor") { legacyCheckpoint(db, "dlr:a", "head", 1, null); legacyCheckpoint(db, "dlr:a", "wrong", 2, sha("wrong")); }
      if (corruption === "cross_run_step") { db.db.prepare("INSERT INTO daily_loop_steps(step_id,run_id,sequence,step_key,state,created_at,updated_at) VALUES('dls:b','dlr:b',1,'b','pending',?,?)").run(T0, T0); legacyCheckpoint(db, "dlr:a", "cross", 1, null, 1, T4, "dls:b"); }
      if (corruption === "expired_snapshot") legacyCheckpoint(db, "dlr:a", "expired", 1, null, 1, T1);
      cpSync(join(process.cwd(), "migrations", "035_daily_loop_durable_guards.sql"), join(fixture.migrations, "035_daily_loop_durable_guards.sql"));

      // When / Then
      await expect(db.migrate()).rejects.toThrow();
      expect(db.db.prepare("SELECT count(*) AS n FROM schema_migrations WHERE id='035_daily_loop_durable_guards.sql'").get()).toEqual({ n: 0 });
      expect(db.db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name LIKE 'daily_loop_migration_035%'").get()).toEqual({ n: 0 });
      expect(db.db.prepare("SELECT count(*) AS n FROM pragma_table_info('daily_loop_runs') WHERE name='record_version'").get()).toEqual({ n: 0 });
    } finally { db.close(); rmSync(fixture.root, { recursive: true, force: true }); }
  });

  it.each(["001_authority.sql", "033_personal_operations.sql", "034_recommendation_transition_identity.sql", "035_daily_loop_durable_guards.sql"])("detects a raw-byte mutation of %s", async name => {
    // Given
    const fixture = migrationRoot(true); const db = new AuthorityDb(fixture.path, fixture.migrations);
    try { await db.migrate(); writeFileSync(join(fixture.migrations, name), Buffer.concat([readFileSync(join(fixture.migrations, name)), Buffer.from("\n-- mutation\n")]));
      // When / Then
      await expect(db.assertMigrationsReady()).rejects.toMatchObject({ code: "MIGRATION_CHECKSUM_MISMATCH" });
    } finally { db.close(); rmSync(fixture.root, { recursive: true, force: true }); }
  });
});

describe("permanent direct-SQL daily-loop guards", () => {
  it("rejects version omission, projection skips, chain gaps, branches, wrong predecessors, and preimage mutation", async () => {
    // Given
    const fixture = migrationRoot(true); const db = new AuthorityDb(fixture.path, fixture.migrations);
    try {
      await db.migrate(); const at = new Date("2026-08-30T22:15:00.000Z"); const loop = new DailyControlLoop(new DailyLoopStore(db), loopOptions(() => at));
      const prepared = loop.prepare({ kind: "scheduled" }); if (prepared.kind !== "prepared") throw new Error("not prepared"); const claim = loop.claim(prepared.run_id);
      const before = db.db.prepare("SELECT count(*) AS n FROM daily_loop_checkpoints").get();

      // When / Then
      expect(() => db.db.prepare("INSERT INTO daily_loop_checkpoints(checkpoint_id,run_id,sequence,state,checkpoint_digest,lease_fence,lease_expires_at,created_at) VALUES('omit',?,1,'running',?,1,?,?)").run(prepared.run_id, sha("omit"), claim.lease_expires_at, at.toISOString())).toThrow();
      for (const sequence of [0, 2]) expect(() => db.db.prepare("INSERT INTO daily_loop_checkpoints(checkpoint_id,run_id,sequence,state,previous_digest,checkpoint_digest,lease_fence,lease_expires_at,created_at,record_version,detail_json) VALUES(?,?,?,?,?,?,?,?,?,?,?)").run(`bad:${sequence}`, prepared.run_id, sequence, "running", sequence === 1 ? null : sha("wrong"), sha(`bad:${sequence}`), 1, claim.lease_expires_at, at.toISOString(), 1, "{}")).toThrow();
      expect(() => db.db.prepare("UPDATE daily_loop_runs SET state='running',updated_at=? WHERE run_id=?").run(at.toISOString(), prepared.run_id)).toThrow("daily loop run checkpoint required");
      expect(db.db.prepare("SELECT count(*) AS n FROM daily_loop_checkpoints").get()).toEqual(before);
      loop.runNext(claim);
      expect(() => db.db.prepare("UPDATE daily_loop_runs SET input_json=input_json||' ' WHERE run_id=?").run(prepared.run_id)).toThrow("immutable daily loop v1 input");
      expect(() => db.db.prepare("UPDATE daily_loop_steps SET detail_json='null' WHERE run_id=? AND sequence=1").run(prepared.run_id)).toThrow();
      expect(() => db.db.prepare("UPDATE daily_loop_checkpoints SET detail_json='null' WHERE run_id=?").run(prepared.run_id)).toThrow("immutable daily loop checkpoint");
    } finally { db.close(); rmSync(fixture.root, { recursive: true, force: true }); }
  });

  it("converges two independent claim/start races without a branch", async () => {
    // Given
    const fixture = migrationRoot(true); const a = new AuthorityDb(fixture.path, fixture.migrations); let b: AuthorityDb | undefined;
    try {
      await a.migrate(); const at = new Date("2026-08-30T22:15:00.000Z"); const service = new DailyControlLoop(new DailyLoopStore(a), loopOptions(() => at));
      const prepared = service.prepare({ kind: "scheduled" }); if (prepared.kind !== "prepared") throw new Error("not prepared"); const bDb = new AuthorityDb(fixture.path, fixture.migrations); b = bDb;
      const attempts = [() => new DailyLoopStore(a).claim({ run_id: prepared.run_id, owner_id: "a", at, lease_ms: 1_000 }), () => new DailyLoopStore(bDb).claim({ run_id: prepared.run_id, owner_id: "b", at, lease_ms: 1_000 })];

      // When
      const results = attempts.map(attempt => { try { return { ok: true as const, claim: attempt() }; } catch { return { ok: false as const }; } });
      const winner = results.find(result => result.ok); if (winner?.ok !== true) throw new Error("no winner");
      new DailyLoopStore(winner.claim.owner_id === "a" ? a : bDb).start(winner.claim, at);

      // Then
      expect(results.filter(result => result.ok)).toHaveLength(1);
      expect(a.db.prepare("SELECT sequence,state FROM daily_loop_checkpoints WHERE run_id=?").all(prepared.run_id)).toEqual([{ sequence: 1, state: "running" }]);
      expect(a.db.prepare("SELECT count(*) AS n FROM daily_loop_checkpoints GROUP BY previous_digest HAVING count(*)>1").all()).toEqual([]);
    } finally { b?.close(); a.close(); rmSync(fixture.root, { recursive: true, force: true }); }
  });
  it("rejects exact post-head predecessor, branch, binding, fence, and lease adversaries with reopen zero deltas", async () => {
    // Given
    const fixture = migrationRoot(true); const db = new AuthorityDb(fixture.path, fixture.migrations);
    try {
      await db.migrate(); const at = new Date("2026-08-30T22:15:00.000Z"); const loop = new DailyControlLoop(new DailyLoopStore(db), loopOptions(() => at)); const prepared = loop.prepare({ kind: "scheduled" }); if (prepared.kind !== "prepared") throw new Error("not prepared"); const claim = loop.claim(prepared.run_id);
      const insert = (id: string, sequence: number, previous: string | null, fence = claim.fence, lease = claim.lease_expires_at, step: string | null = null): void => { db.db.prepare("INSERT INTO daily_loop_checkpoints(checkpoint_id,run_id,step_id,sequence,state,previous_digest,checkpoint_digest,lease_fence,lease_expires_at,created_at,record_version,detail_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)").run(`dlc:${id}`, prepared.run_id, step, sequence, sequence === 1 ? "running" : "failed", previous, sha(id), fence, lease, at.toISOString(), 1, "{}"); };
      insert("head", 1, null); db.db.prepare("UPDATE daily_loop_runs SET state='running',updated_at=? WHERE run_id=?").run(at.toISOString(), prepared.run_id); const head = sha("head");
      const expectZero = (operation: () => void): void => { const before = db.db.prepare("SELECT count(*) AS n FROM daily_loop_checkpoints").get(); expect(operation).toThrow(); expect(db.db.prepare("SELECT count(*) AS n FROM daily_loop_checkpoints").get()).toEqual(before); };

      // When / Then
      expectZero(() => insert("wrong", 2, sha("wrong"))); expectZero(() => insert("null", 2, null)); expectZero(() => insert("duplicate", 1, null)); expectZero(() => insert("stale", 2, head, 0)); expectZero(() => insert("future", 2, head, 2)); expectZero(() => insert("skipped", 2, head, 3)); expectZero(() => insert("lease", 2, head, 1, "2026-08-30T22:16:00.001Z"));
      const other = new DailyControlLoop(new DailyLoopStore(db), loopOptions(() => new Date("2026-08-31T22:15:00.000Z")))
        .prepare({ kind: "scheduled" }); if (other.kind !== "prepared") throw new Error("other not prepared"); const otherStep = db.db.prepare("SELECT step_id FROM daily_loop_steps WHERE run_id=?").get(other.run_id) as { step_id: string }; expectZero(() => insert("cross", 2, head, 1, claim.lease_expires_at, otherStep.step_id));
      insert("child", 2, head); expectZero(() => insert("branch", 3, head)); const reopened = new AuthorityDb(fixture.path, fixture.migrations); expect(reopened.db.prepare("SELECT count(*) AS n FROM daily_loop_checkpoints WHERE checkpoint_id IN ('dlc:wrong','dlc:null','dlc:duplicate','dlc:stale','dlc:future','dlc:skipped','dlc:lease','dlc:cross','dlc:branch')").get()).toEqual({ n: 0 }); expect(reopened.db.prepare("SELECT count(*) AS n FROM daily_loop_checkpoints c WHERE c.sequence>1 AND NOT EXISTS(SELECT 1 FROM daily_loop_checkpoints p WHERE p.run_id=c.run_id AND p.sequence=c.sequence-1 AND p.checkpoint_digest=c.previous_digest)").get()).toEqual({ n: 0 }); reopened.close();
    } finally { db.close(); rmSync(fixture.root, { recursive: true, force: true }); }
  });

});
