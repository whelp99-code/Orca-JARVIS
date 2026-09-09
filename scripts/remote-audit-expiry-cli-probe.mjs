// Run after build:backend. Uses a new DB with no GJC configuration or real audit data.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { AuthorityDb } from "../dist/src/db.js";
import { RetentionRuntime } from "../dist/src/personal-os-retention.js";
import { createTestEnvironment } from "./lib/test-environment.mjs";

const scratch = createTestEnvironment();
const path = join(scratch.root, "authority.sqlite");
const today = new Date().toISOString().slice(0, 10);
const midnight = Date.parse(`${today}T00:00:00.000Z`);
const previous = new Date(midnight - 86400000).toISOString();
const earlier = new Date(midnight - 2 * 86400000).toISOString();
const pending = `remote-auth:daily:v1:${earlier.slice(0, 10)}`;
const claimed = `remote-auth:daily:v1:${previous.slice(0, 10)}`;
let db;
try {
  db = new AuthorityDb(path); await db.migrate();
  const runtime = new RetentionRuntime(db.db, "fixture", {}, () => new Date(previous));
  for (const id of [pending, claimed]) runtime.createJob({ jobId: id,
    jobKey: `${id}:limit:1`, idempotencyKey: `${id}:limit:1`, dataClass: "audit",
    createdAt: earlier, notBefore: earlier, expiresAt: new Date(midnight).toISOString(), cutoff: earlier });
  runtime.claimDue({ jobId: claimed, now: previous,
    leaseExpiresAt: new Date(Date.parse(previous) + 60000).toISOString() });
  db.close(); db = undefined;
  const env = { ...scratch.env }; delete env.PERSONAL_OS_CONTROL_CHANNEL;
  const invoke = enabled => {
    const result = spawnSync(process.execPath, [resolve("dist/src/cli.js"), "service", "once", "--db", path,
      ...(enabled ? ["--remote-audit-retention-limit", "1"] : [])],
    { cwd: scratch.root, env, encoding: "utf8", timeout: 30000 });
    assert.equal(result.status, 0, result.stderr);
    const body = JSON.parse(result.stdout);
    assert.equal(body.state, "disconnected");
    return body;
  };
  const readJobs = () => {
    const reader = new AuthorityDb(path);
    try { return reader.db.prepare("SELECT job_id,state,failure_code,lease_owner IS NULL AS lease_cleared,result_digest FROM retention_jobs ORDER BY job_id").all(); }
    finally { reader.close(); }
  };
  const before = readJobs();
  invoke(false); assert.deepEqual(readJobs(), before);
  const first = invoke(true);
  assert.equal(first.remote_audit_retention.status, "completed");
  const settled = readJobs();
  assert.equal(settled.find(row => row.job_id === pending).state, "failed");
  assert.equal(settled.find(row => row.job_id === claimed).state, "uncertain");
  for (const id of [pending, claimed]) {
    const row = settled.find(row => row.job_id === id);
    assert.equal(row.failure_code, "E_RETENTION_EXPIRED"); assert.equal(row.lease_cleared, 1);
  }
  const replay = invoke(true);
  assert.equal(new Date().toISOString().slice(0, 10), today, "UTC date changed during probe; rerun on stable date");
  assert.deepEqual(replay.remote_audit_retention, first.remote_audit_retention);
  assert.deepEqual(readJobs(), settled);
  const receipt = { scope: "three separate compiled service CLI processes, private file-backed DB, no GJC configuration",
    cli_processes: 3, disabled_retention_unchanged: true, old_pending: "failed", old_claimed: "uncertain",
    current_batch: "completed", restart_retention_rows_unchanged: true };
  if (process.argv[2]) writeFileSync(process.argv[2], `${JSON.stringify(receipt, null, 2)}\n`);
  console.log(JSON.stringify(receipt));
} finally { db?.close(); scratch.cleanup(); }
