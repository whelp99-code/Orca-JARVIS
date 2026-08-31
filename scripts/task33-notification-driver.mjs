#!/usr/bin/env node
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthorityDb, NotificationDeliveryStore } from "../dist/src/index.js";
import { packageElectronApp } from "./lib/package-electron-app.mjs";
import { parseElectronClientConfig } from "./lib/electron-shell.mjs";

const root = mkdtempSync(join(tmpdir(), "task33-driver-"));
const db = new AuthorityDb(join(root, "authority.sqlite"));
const server = createServer((request, response) => {
  if (request.url === "/api/v1/session") {
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ schema_version: 1, csrf_token: "a".repeat(43) })); return;
  }
  if (request.url === "/api/v1/events") {
    response.setHeader("Content-Type", "text/event-stream"); response.flushHeaders();
    response.write(`id: 00000000-0000-4000-8000-000000000001:1\nevent: snapshot\ndata: ${JSON.stringify({
      schema_version: 1, type: "snapshot", revision: "00000000-0000-4000-8000-000000000001:1",
      topics: ["personal.notification-intents.v1"], occurred_at: "2026-08-28T12:00:00.000Z",
    })}\n\n`); return;
  }
  if (request.url === "/api/v1/notification-deliveries/claim" && request.method === "POST") {
    request.resume(); response.statusCode = 204; response.end(); return;
  }
  response.setHeader("Content-Type", "text/html"); response.end("<!doctype html><title>JARVIS</title>");
});
async function runPackage(executable, args, expected, streamName) {
  const child = spawn(executable, ["--no-sandbox", "--disable-gpu", `--user-data-dir=${join(root, expected)}`, ...args],
    { stdio: ["ignore", "pipe", "pipe"] });
  const stream = streamName === "stdout" ? child.stdout : child.stderr;
  const signal = AbortSignal.timeout(20_000); let output = ""; let diagnostic = "";
  child.stdout.on("data", chunk => { diagnostic += chunk.toString("utf8"); });
  child.stderr.on("data", chunk => { diagnostic += chunk.toString("utf8"); });
  const found = new Promise((resolve, reject) => {
    stream.on("data", chunk => { output += chunk.toString("utf8"); if (output.includes(expected)) resolve(output); });
    signal.addEventListener("abort", () => reject(new TypeError(`package launch timeout: ${diagnostic}`)), { once: true });
    child.once("exit", code => { if (!output.includes(expected)) reject(new TypeError(`package exited ${code}: ${diagnostic}`)); });
  });
  try { await found; } finally {
    if (child.exitCode === null) { child.kill("SIGTERM"); await once(child, "exit"); }
  }
}
try {
  await db.migrate();
  db.db.prepare(`INSERT INTO notification_intents(intent_id,correlation_id,idempotency_key,dedup_key,urgency,channel,
    redacted_preview,deep_link,state,expires_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run("ntf:pos:v1:driver", "thread:driver", "idem:driver", "dedup:driver", "action", "mac", "Review decision",
      "/recommendations/rec%3Apos%3Av1%3Adriver?rank=1", "created", "2026-08-28T13:00:00.000Z",
      "2026-08-28T11:00:00.000Z", "2026-08-28T11:00:00.000Z");
  db.db.prepare("UPDATE notification_intents SET state='queued',updated_at=? WHERE intent_id='ntf:pos:v1:driver'")
    .run("2026-08-28T12:00:00.000Z");
  const tableNames = db.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all().map(row => row.name);
  const counts = () => Object.fromEntries(tableNames.map(name => [name, db.db.prepare(`SELECT count(*) FROM "${name}"`).pluck().get()]));
  const before = counts(); const store = new NotificationDeliveryStore({ authority: db, resourceIsCurrent: () => true });
  const claim = store.claim("2026-08-28T12:00:00.000Z", "dashboard-session:driver");
  if (claim === null) throw new TypeError("claim required");
  const settlement = store.settle({ deliveryId: claim.delivery_id, input: { schema_version: 1, outcome: "delivered" },
    now: "2026-08-28T12:00:00.001Z", sessionId: "dashboard-session:driver" });
  if (settlement.state !== "delivered" || store.claim("2026-08-28T12:00:00.002Z", "dashboard-session:driver") !== null) {
    throw new TypeError("delivery settlement invalid");
  }
  const after = counts();
  const unexpected = tableNames.filter(name => name !== "notification_deliveries" && after[name] !== before[name]);
  if (after.notification_deliveries - before.notification_deliveries !== 1 || unexpected.length !== 0) {
    throw new TypeError("table delta invalid");
  }
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") throw new TypeError("server address required");
  const config = parseElectronClientConfig({ JARVIS_AUTHORITY_URL: `http://127.0.0.1:${address.port}` });
  const packaged = packageElectronApp(root, config);
  const main = readFileSync(join(packaged.appResources, "app", "main.cjs"), "utf8");
  if (!main.includes("requestSingleInstanceLock") || !main.includes("/api/v1/notification-deliveries/claim")) {
    throw new TypeError("package contract invalid");
  }
  await runPackage(packaged.executable, [], "TASK33_PACKAGED_ELECTRON_HAPPY_PASS", "stdout");
  await runPackage(packaged.executable, ["--help"], "TASK33_PACKAGED_ELECTRON_HELP_PASS", "stdout");
  await runPackage(packaged.executable, ["jarvis://evil/today"], "ELECTRON_DEEP_LINK_INVALID", "stderr");
  process.stdout.write("TASK33_TABLE_DELTAS_PASS unexpected_tables=0\n");
  process.stdout.write("TASK33_EFFECT_DELTAS_PASS unauthorized_effects=0 duplicate_shows=0\n");
  process.stdout.write("TASK33_PACKAGED_ELECTRON_HAPPY_PASS\nTASK33_PACKAGED_ELECTRON_HELP_PASS\n");
  process.stdout.write("TASK33_PACKAGED_ELECTRON_BAD_PATHS_PASS\nTASK33_NOTIFICATION_DRIVER_PASS\n");
} finally {
  server.closeAllConnections(); server.close(); db.close(); rmSync(root, { recursive: true, force: true });
}
