// Run after build:backend. Isolated fixture only; no provider or production access.
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createTestEnvironment } from "./lib/test-environment.mjs";
import { runTestProcess } from "./lib/test-process.mjs";
import { taskPublicationFixture } from "../dist/tests/fixtures/task-publication-fixture.js";
import { stageTaskExecution } from "../dist/src/task-execution-staging.js";
import { pageControlCommands } from "../dist/src/control-command-page.js";

if (process.argv[2] !== "--isolated") {
  const scratch = createTestEnvironment();
  let code;
  try {
    const result = await runTestProcess(process.execPath,
      [fileURLToPath(import.meta.url), "--isolated", ...process.argv.slice(2)],
      { env: scratch.env, timeoutMs: 120000 });
    code = result.code ?? 1;
  } finally { scratch.cleanup(); }
  process.exit(code);
}
process.argv.splice(2, 1);
const results = [];
for (const population of [10000, 100000]) {
  const f = await taskPublicationFixture();
  try {
    let prior;
    for (let i = 0; i < 63; i++) {
      prior = stageTaskExecution(f.db, { ...f.request, plan: f.plan,
        request_id: `ancestor-${i}`, nonce: `ancestor-${i}`,
        work_lineage: prior ? { schema_version: 1, kind: "retry",
          prior_request_id: prior.request_id, prior_command_digest: prior.command_digest }
          : { schema_version: 1, kind: "original" } }, new Date(f.now.getTime() + i));
    }
    for (let i = 0; i < 100; i++) stageTaskExecution(f.db, { ...f.request, plan: f.plan,
      request_id: `leaf-${String(i).padStart(3, "0")}`, nonce: `leaf-${i}`,
      work_lineage: { schema_version: 1, kind: "retry",
        prior_request_id: prior.request_id, prior_command_digest: prior.command_digest } },
    new Date(f.now.getTime() + 100));
    const insert = f.db.db.prepare(`INSERT INTO control_command_requests
      (request_id,action,action_level,target_json,args_json,command_digest,reversible,requested_by,requested_at,expires_at,nonce,state,created_at)
      VALUES (?,'workflow.start',2,'{}',?, ?,1,'probe',?, ?,?,'pending',?)`);
    const at = new Date(f.now.getTime() + 1000).toISOString();
    const existing = f.db.db.prepare("SELECT count(*) AS n FROM control_command_requests").get().n;
    f.db.db.transaction(() => {
      for (let i = existing; i < population; i++) insert.run(`filler-${i}`,
        JSON.stringify({ text: "x".repeat(1024) }), `sha256:${i.toString(16).padStart(64, "0")}`,
        at, new Date(f.now.getTime() + 3600000).toISOString(), `filler-${i}`, at);
    })();
    // One start command plus 63 ancestors precede the leaf page.
    const first = pageControlCommands(f.db, 64);
    assert.equal(first.requests.length, 64);
    const before = f.db.db.serialize();
    const prepare = f.db.db.prepare;
    let queries = 0;
    f.db.db.prepare = function (sql) {
      const statement = prepare.call(this, sql);
      for (const method of ["get", "all", "run"]) {
        const original = statement[method];
        statement[method] = function (...args) { queries++; return original.apply(this, args); };
      }
      return statement;
    };
    const samples = [];
    try {
      for (let i = 0; i < 5; i++) {
        queries = 0;
        const start = performance.now();
        const page = pageControlCommands(f.db, 100, first.page.next_cursor);
        const ms = performance.now() - start;
        assert.equal(page.requests.length, 100);
        assert.ok(page.requests.every(row => row.request_id.startsWith("leaf-")));
        samples.push({ ms, queries, bytes: Buffer.byteLength(JSON.stringify(page)) });
      }
    } finally { f.db.db.prepare = prepare; }
    assert.ok(f.db.db.serialize().equals(before));
    const times = samples.map(sample => sample.ms).sort((a, b) => a - b);
    results.push({ population, ancestors: 63, leaves: 100, samples,
      p50_ms: times[2], p95_ms: times[4], read_writes: 0 });
  } finally { await f.cleanup(); }
}
const receipt = { scope: "isolated compiled fixture; five instrumented samples; shared deep lineage; no concurrency or production SLO", results };
if (process.argv[2]) writeFileSync(process.argv[2], `${JSON.stringify(receipt, null, 2)}\n`);
console.log(JSON.stringify(receipt));
