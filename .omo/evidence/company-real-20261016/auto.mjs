import assert from "node:assert/strict";
import { existsSync, readFileSync, watch, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { AuthorityDb } from "../../../dist/src/db.js";
import { CompanyInternalClient } from "../../../dist/src/company-internal-client.js";
import { CompanySbReportSource } from "../../../dist/src/company-sb-report-source.js";
import { CompanyDailyReportCycle } from "../../../dist/src/company-daily-report-cycle.js";
const root = process.argv[2] ?? "/dev/shm/jfc.1KGFZ5/real-auto-wire";
const meta = JSON.parse(readFileSync(join(root, "integration.json"), "utf8"));
const base = fileURLToPath(new URL("../../../", import.meta.url));
const binary = join(root, "actual-sb-company");
writeFileSync(binary, `#!/bin/sh\nexec /home/jm/orca/projects/second-brain-app/.venv/bin/python -B '${fileURLToPath(new URL("./sb-cli-harness.py", import.meta.url))}' "$@"\n`, { mode: 0o700 });
const json = (path, value) => writeFileSync(path, JSON.stringify(value), { mode: 0o600 });
const children = [];
async function start(role) {
  const socket = join(root, `${role}.sock`);
  const config = join(root, `${role}-broker.json`);
  json(config, { schema_version: 1, role, socket, sb_company_bin: binary, sb_config_file: meta.config,
    ...(role === "processor" ? { auto_config_file: meta.config } : { report_config_file: meta.config }) });
  const ready = join(root, `${role}.ready`);
  let child;
  const listening = new Promise((resolve, reject) => {
    const watcher = watch(root, (_event, name) => {
      if (name === `${role}.ready` && existsSync(ready)) { clearTimeout(timer); watcher.close(); resolve(); }
    });
    const timer = setTimeout(() => { watcher.close(); reject(new Error("actual broker ready timeout")); }, 5000);
    child = spawn(process.execPath, [join(base, "dist/tests/fixtures/company-freshness-broker-worker.mjs"), config, ready], { stdio: ["ignore", "ignore", "pipe"] });
    child.stderr.on("data", data => process.stderr.write(data));
    child.once("exit", code => { if (code !== 0) { clearTimeout(timer); watcher.close(); reject(new Error(`broker exit ${code}`)); } });
  });
  children.push(child);
  await listening;
  const client = join(root, `${role}-client.json`);
  json(client, { schema_version: 2, role: "freshness", installation_id: meta.installation_id, socket,
    signing_key_id: "progress:TEST_ONLY", signing_key_file: join(root, "progress.pem"),
    context: { ...meta.context, principal_id: "principal:jarvis-company-progress" } });
  return client;
}
let db;
try {
  const triggerPath = await start("processor");
  const reportPath = await start("handoff");
  db = new AuthorityDb(join(root, "jarvis.sqlite")); await db.migrate();
  const trigger = new CompanyInternalClient(triggerPath, db);
  const first = trigger.trigger();
  assert.equal(first.outcomes.filter(row => row.classification === "auto_internal").length, 3);
  assert.equal(first.outcomes.filter(row => row.classification === "human_required").length, 2);
  assert.ok(first.outcomes.filter(row => row.classification === "human_required").every(row => row.effect_count === 0));
  const second = trigger.trigger();
  const reportClient = new CompanyInternalClient(reportPath, db);
  const cycle = new CompanyDailyReportCycle(db, { enabled: true, scope: reportClient.scope,
    activation_cutoff: meta.activation_cutoff, source: new CompanySbReportSource(reportClient) });
  const published = cycle.publishDue(new Date("2026-10-17T09:00:00.000Z"));
  assert.equal(published.status, "published");
  const document = JSON.parse(db.db.prepare("SELECT report_json FROM company_daily_reports").pluck().get());
  assert.equal(document.counts.completed, 3);
  assert.equal(document.counts.human_required, 2);
  assert.equal(document.counts.conflict, 2);
  assert.equal(document.rows.length, 5);
  assert.equal(db.db.prepare("SELECT count(*) FROM control_command_receipts").pluck().get(), 0);
  const repeated = cycle.publishDue(new Date("2026-10-17T09:00:00.000Z"));
  assert.equal(repeated.created, false);
  assert.equal(db.db.prepare("SELECT count(*) FROM notification_intents").pluck().get(), 1);
  console.log(JSON.stringify({ label: "actual signed broker -> actual SB auto CLI -> SQL -> fixed report read; simulated anchor only",
    first, second, published, repeated, counts: document.counts, rows: document.rows,
    fabricated_human_receipts: 0, notification_intents: 1 }));
} finally {
  db?.close();
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) { const exited = once(child, "close"); child.kill("SIGTERM"); await exited; }
  }
}
