import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, createPrivateKey } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import process from "node:process";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const build = resolve(process.argv[2]);
const moduleAt = name => import(pathToFileURL(join(build, "src", `${name}.js`)));
const { AuthorityDb } = await moduleAt("db");
const { MemoryCorrectionCancellationIssuer } = await moduleAt("memory-correction-cancellation-issuer");
const { MemoryDestructiveDispatchCursor } = await moduleAt("memory-destructive-dispatch");
if (process.argv[3] === "actor") {
  const input = JSON.parse(readFileSync(0, "utf8"));
  const db = new AuthorityDb(input.path);
  try {
    let value;
    if (input.action === "claim") {
      const row = db.db.prepare("SELECT * FROM memory_correction_requests WHERE correction_id=?").get(input.correction_id);
      value = new MemoryDestructiveDispatchCursor(db).claim({ lane: "correction", lane_id: row.lane_id,
        sequence: row.tombstone_sequence, request_digest: row.request_digest }, new Date(input.now));
    } else {
      value = new MemoryCorrectionCancellationIssuer(db, () => new Date(input.now))
        .issue(input.correction_id, input.key_id, createPrivateKey(input.private_key));
      if (input.action === "issue-crash") process.exit(77);
    }
    process.stdout.write(JSON.stringify({ pid: process.pid, value }) + "\n");
  } catch (error) { process.stdout.write(JSON.stringify({ pid: process.pid, error: error.code ?? error.message }) + "\n"); }
  finally { db.close(); }
} else {
  const { cancellationDatabaseFixture } = await import(pathToFileURL(join(build, "tests/fixtures/memory-cancellation-db.js")));
  const work = mkdtempSync(join(tmpdir(), "cancellation-db-acceptance-"));
  const reports = [];
  const actor = (f, action) => new Promise((resolveActor, reject) => {
    const child = execFile(process.execPath, [process.argv[1], build, "actor"], { timeout: 30_000 }, (error, stdout, stderr) => {
      if (action === "issue-crash") {
        if (error?.code !== 77) return reject(new Error(`expected exit77, observed ${error?.code}: ${stderr}`));
        return resolveActor({ pid: child.pid, exit: 77 });
      }
      if (error) return reject(error);
      resolveActor(JSON.parse(stdout));
    });
    child.stdin.end(JSON.stringify({ path: f.database.path, correction_id: f.record.correction_id,
      now: f.runtime.clock().toISOString(), action, key_id: f.runtime.signing_key_id,
      private_key: f.runtime.private_key.export({ format: "pem", type: "pkcs8" }).toString() }));
  });
  for (const first of ["cancellation", "claim"]) {
    const f = await cancellationDatabaseFixture();
    try {
      const spool = readFileSync(f.spoolPath);
      if (first === "cancellation") {
        const crashed = await actor(f, "issue-crash");
        const saved = f.db.db.prepare("SELECT intent_json FROM memory_correction_cancellation_intents").get().intent_json;
        const replay = await actor(f, "issue");
        assert.equal(replay.value.intent_id, JSON.parse(saved).intent_id);
        const { canonicalize } = await moduleAt("canonical");
        assert.equal(canonicalize(replay.value), saved);
        const denied = await actor(f, "claim");
        assert.equal(denied.error, "MEMORY_REQUEST_CANCELLED");
        assert.equal(saved.includes(f.staged.content), false);
        writeFileSync(join(work, "intent.json"), saved + "\n");
        writeFileSync(join(work, "validation.json"), JSON.stringify({ now: f.runtime.clock().toISOString(),
          provider_instance_id: "provider:fixture", key_id: f.runtime.signing_key_id }) + "\n");
        reports.push({ first, pids: [crashed.pid, replay.pid, denied.pid], exit_after_commit: 77,
          intent_id: replay.value.intent_id, canonical_replay: true, later_claim: denied.error });
      } else {
        const claimed = await actor(f, "claim");
        assert.equal(claimed.value.kind, "claimed");
        const denied = await actor(f, "issue");
        assert.equal(denied.error, "MEMORY_CANCELLATION_UNSENT_UNPROVED");
        assert.equal(f.db.db.prepare("SELECT count(*) AS n FROM memory_correction_cancellation_intents").get().n, 0);
        reports.push({ first, pids: [claimed.pid, denied.pid], later_issuance: denied.error, intents: 0 });
      }
      assert.deepEqual(readFileSync(f.spoolPath), spool);
      assert.equal(f.writer.calls.length, 0);
    } finally { await f.close(); }
  }
  const report = { parent_pid: process.pid, reports, original_transport_calls: 0, spool_preserved: true,
    intent_file_sha256: createHash("sha256").update(readFileSync(join(work, "intent.json"))).digest("hex"),
    scope: "actual SQLite authority and separate Node actors; provider submission and cursor settlement not activated" };
  writeFileSync(join(work, "result.json"), JSON.stringify(report, null, 2) + "\n");
  process.stdout.write(join(work, "result.json") + "\n" + JSON.stringify(report) + "\n");
}
