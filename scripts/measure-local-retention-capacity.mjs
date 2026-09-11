#!/usr/bin/env node
// Measures what repeated retention cycles do to a database, so the growth story is numbers.
//
// Each round admits one collection per registered task, runs one scheduled cycle, and records the
// row counts and the bytes of the database and its sidecars. Cache rows fall; immutable
// observations and audit rows do not, which is why total bytes can keep rising even when
// retention is working exactly as specified.
import { mkdtempSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AuthorityDb } from "../dist/src/db.js";
import { AuthorityDatabaseRuntime } from "../dist/src/authority-database-runtime.js";
import { LocalObservationRetentionService } from "../dist/src/local-observation-retention-service.js";
import { LocalTimelineSnapshotStore } from "../dist/src/local-timeline-snapshot-store.js";
import { admitLocalTimelineObservation } from "../dist/src/local-timeline-observation.js";

const rounds = Number(process.argv[2] ?? 5);
const root = mkdtempSync(join(process.env.TMPDIR ?? "/var/tmp", "jarvis-retention-capacity-"));
const path = join(root, "authority.sqlite");
const retainMs = 300_000;
const db = new AuthorityDb(path);
await db.migrate();

const task = "task:capacity";
db.db.prepare(`INSERT INTO gjc_intents(intent_id,continuation_id,kind,payload_json,payload_digest,
  idempotency_key,state,created_at) VALUES(?,?,'dispatch','{}','sha256:fixture',?,'pending',?)`)
  .run("capacity", task, "capacity", "2026-08-28T11:00:00.000Z");

let now = new Date("2026-08-28T12:00:00.000Z");
const store = new LocalTimelineSnapshotStore(db, () => now);
store.register(task);
const config = join(root, "retention.json");
writeFileSync(config, JSON.stringify({ schema_version: 1, retain_ms: retainMs }));
const runtime = new AuthorityDatabaseRuntime(db, {
  registry_root: join(root, "registry"), watchdog_ms: 1000,
});
const service = new LocalObservationRetentionService(db, {
  config_path: config, runtime, interval_ms: 3_600_000, clock: () => now,
});

const count = table => Number(db.db.prepare(`SELECT COUNT(*) FROM ${table}`).pluck().get());
const bytes = suffix => { try { return statSync(`${path}${suffix}`).size; } catch { return 0; } };
const sample = round => ({
  round,
  at: now.toISOString(),
  cached_subjects: Number(db.db.prepare(
    "SELECT COUNT(*) FROM local_timeline_subjects WHERE snapshot_json IS NOT NULL")
    .pluck().get()),
  cached_snapshot_bytes: Number(db.db.prepare(
    "SELECT COALESCE(SUM(LENGTH(snapshot_json)),0) FROM local_timeline_subjects")
    .pluck().get()),
  observations: count("personal_observations"),
  context: count("personal_context_observations"),
  recommendations: count("personal_recommendations"),
  audit_events: count("personal_context_audit_events"),
  operations: count("local_retention_operations"),
  main_bytes: bytes(""),
  wal_bytes: bytes("-wal"),
  shm_bytes: bytes("-shm"),
});

const samples = [sample(0)];
for (let round = 1; round <= rounds; round++) {
  now = new Date(now.getTime() + 2 * 3_600_000);
  const snapshot = store.refresh(task);
  admitLocalTimelineObservation(db, task, snapshot.collection_id, () => now);
  const started = Date.now();
  const cycle = await service.cycle();
  const cycleMs = Date.now() - started;
  samples.push({ ...sample(round), status: cycle.status,
    removed: cycle.status === "processed" ? cycle.removed : null,
    cycle_ms: cycleMs, rss_bytes: process.memoryUsage().rss });
}
db.close();
process.stdout.write(`${JSON.stringify({ root, rounds, retain_ms: retainMs, samples }, null, 2)}\n`);
