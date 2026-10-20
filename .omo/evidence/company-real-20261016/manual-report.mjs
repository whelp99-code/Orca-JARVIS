import assert from "node:assert/strict";
import { readFileSync, writeFileSync, watch, existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execute } from "../../../dist/src/cli.js";
import { AuthorityDb } from "../../../dist/src/db.js";
const root = "/dev/shm/jfc.1KGFZ5/real-auto-wire";
const meta = JSON.parse(readFileSync(join(root, "integration.json"), "utf8"));
const config = join(root, "manual-report-config.json");
writeFileSync(config, JSON.stringify({ schema_version: 1, enabled: true,
  activation_cutoff: meta.activation_cutoff, report_client_config_file: join(root, "handoff-client.json") }), { mode: 0o600 });
const dbPath = join(root, "manual-jarvis.sqlite");
const db = new AuthorityDb(dbPath); await db.migrate(); db.close();
const ready = join(root, `manual-${randomUUID()}.ready`);
let child;
const listening = new Promise((resolve, reject) => {
  const watcher = watch(root, (_event, name) => {
    if (name === ready.slice(root.length + 1) && existsSync(ready)) { clearTimeout(timer); watcher.close(); resolve(); }
  });
  const timer = setTimeout(() => { watcher.close(); reject(new Error("manual report broker readiness timeout")); }, 5000);
  child = spawn(process.execPath, [fileURLToPath(new URL("../../../dist/tests/fixtures/company-freshness-broker-worker.mjs", import.meta.url)),
    join(root, "handoff-broker.json"), ready], { stdio: ["ignore", "ignore", "pipe"] });
  child.stderr.on("data", data => process.stderr.write(data));
});
try {
  await listening;
  const args = ["company-candidates", "daily-report", "--date", "2026-10-17", "--company-config", config, "--db", dbPath, "--json"];
  const clock = () => new Date("2026-10-17T09:00:00.000Z");
  const first = await execute(args, { clock });
  const second = await execute(args, { clock });
  assert.equal(first.command, "company-candidates.daily-report");
  assert.equal(first.report.created, true); assert.equal(second.report.created, false);
  assert.equal(first.report.report_id, second.report.report_id);
  await assert.rejects(execute(args), { code: "COMPANY_CALLER_CONFIG_INVALID" });
  const check = new AuthorityDb(dbPath);
  const evidence = {
    reports: check.db.prepare("SELECT count(*) FROM company_daily_reports").pluck().get(),
    notifications: check.db.prepare("SELECT count(*) FROM notification_intents").pluck().get(),
    human_receipts: check.db.prepare("SELECT count(*) FROM control_command_receipts").pluck().get(),
  };
  check.close();
  assert.deepEqual(evidence, { reports: 1, notifications: 1, human_receipts: 0 });
  console.log(JSON.stringify({ command: args.slice(0, 5), label: "actual CLI parser/runtime; clock is an explicit test dependency, not a product flag",
    first, second, future_default_clock: "refused", ...evidence }));
} finally {
  if (child?.exitCode === null && child?.signalCode === null) { const close = once(child, "close"); child.kill("SIGTERM"); await close; }
}
