#!/usr/bin/env node
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthorityDb } from "../dist/src/index.js";
import { createDashboardServer } from "../dist/src/dashboard/server.js";
import { packageElectronApp } from "./lib/package-electron-app.mjs";
import { parseElectronClientConfig } from "./lib/electron-shell.mjs";

const NOW = "2026-08-28T12:00:00.000Z"; const EXPIRES = "2026-08-28T13:00:00.000Z";
const root = mkdtempSync(join(tmpdir(), "task33-driver-")); const db = new AuthorityDb(join(root, "authority.sqlite"));
let server; let proxy;
async function runPackage(executable, options) {
  const child = spawn(executable, ["--no-sandbox", "--disable-gpu",
    `--user-data-dir=${join(root, options.expected.replaceAll(" ", "-"))}`, ...options.args],
  { stdio: ["ignore", "pipe", "pipe"] });
  const stream = options.streamName === "stdout" ? child.stdout : child.stderr; const signal = AbortSignal.timeout(20_000);
  let output = ""; let diagnostic = "";
  child.stdout.on("data", chunk => { diagnostic += chunk.toString("utf8"); });
  child.stderr.on("data", chunk => { diagnostic += chunk.toString("utf8"); });
  const found = new Promise((resolve, reject) => {
    const read = chunk => { output += chunk.toString("utf8"); if (output.includes(options.expected)) resolve(output); };
    stream.on("data", read);
    signal.addEventListener("abort", () => reject(new TypeError(`package launch timeout: ${diagnostic}`)), { once: true });
    child.once("exit", code => {
      if (!output.includes(options.expected)) reject(new TypeError(`package exited ${code}: ${diagnostic}`));
    });
  });
  try { return await found; } finally { if (child.exitCode === null) { child.kill("SIGTERM"); await once(child, "exit"); } }
}
function seedAuthority() {
  const digest = suffix => `sha256:${suffix.repeat(64).slice(0, 64)}`;
  const context = "ctx:pos:v1:driver"; const recommendation = "rec:pos:v1:driver";
  db.db.prepare(`INSERT INTO personal_context_snapshots(context_id,idempotency_key,purpose,declared_query,version,
    canonical_digest,persistence_digest,canonical_envelope_json,payload_state,freshness_state,fresh_until,item_count,
    observation_count,evidence_count,memory_count,max_items,max_excerpt_bytes,max_total_bytes,conflict_count,omission_count,
    observed_at,valid_at,expires_at,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(context, "idem:context:driver", "driver", "driver", 1, digest("1"), digest("2"), "{}", "sufficient", "fresh",
      EXPIRES, 0, 0, 0, 0, 1, 16, 64, 0, 0, NOW, NOW, EXPIRES, NOW);
  db.db.prepare(`INSERT INTO personal_recommendations(recommendation_id,idempotency_key,context_id,context_digest,
    canonical_digest,evidence_digest,persistence_digest,canonical_envelope_json,approval_requirement,confidence_class,
    lifecycle_state,observed_at,valid_at,expires_at,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(recommendation, "idem:recommendation:driver", context, digest("1"), digest("3"), digest("4"), digest("5"), "{}",
      "owner", "high", "eligible", NOW, NOW, EXPIRES, NOW);
  db.db.prepare(`INSERT INTO personal_recommendation_actions(recommendation_id,rank,title,operation,target_digest,initial_state)
    VALUES(?,?,?,?,?,'pending')`).run(recommendation, 1, "Review decision", "review", digest("6"));
  db.db.prepare(`INSERT INTO notification_intents(intent_id,correlation_id,idempotency_key,dedup_key,urgency,channel,
    redacted_preview,deep_link,state,expires_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run("ntf:pos:v1:driver", "thread:driver", "idem:intent:driver", "dedup:driver", "action", "mac", "Review decision",
      `/recommendations/${encodeURIComponent(recommendation)}?rank=1`, "created", EXPIRES, NOW, NOW);
  db.db.prepare("UPDATE notification_intents SET state='queued',updated_at=? WHERE intent_id='ntf:pos:v1:driver'").run(NOW);
}
try {
  await db.migrate(); seedAuthority();
  const tables = db.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all().map(row => row.name);
  const counts = () => Object.fromEntries(tables.map(name => [name, db.db.prepare(`SELECT count(*) FROM "${name}"`).pluck().get()]));
  const before = counts();
  server = createDashboardServer({ db, staticRoot: join(process.cwd(), "dist", "dashboard"), host: "127.0.0.1", port: 0,
    clock: () => new Date(NOW) });
  const authorityUrl = `http://${server.address.host}:${server.address.port}`;
  const requests = { claims: 0, settles: 0, events: 0 };
  proxy = createServer((incoming, outgoing) => {
    const path = incoming.url ?? "/";
    if (path === "/api/v1/notification-deliveries/claim") requests.claims += 1;
    if (path.endsWith("/settle")) requests.settles += 1;
    if (path === "/api/v1/events") requests.events += 1;
    const target = new URL(path, authorityUrl); const headers = { ...incoming.headers, host: target.host };
    if (headers.origin !== undefined) headers.origin = authorityUrl;
    const upstream = httpRequest(target, { method: incoming.method, headers }, response => {
      outgoing.writeHead(response.statusCode ?? 502, response.headers); response.pipe(outgoing);
    });
    upstream.on("error", error => { outgoing.destroy(error); }); incoming.pipe(upstream);
  });
  proxy.listen(0, "127.0.0.1"); await once(proxy, "listening");
  const proxyAddress = proxy.address();
  if (proxyAddress === null || typeof proxyAddress === "string") throw new TypeError("proxy address required");
  const proxyUrl = `http://127.0.0.1:${proxyAddress.port}`;
  const packaged = packageElectronApp(root, parseElectronClientConfig({ JARVIS_AUTHORITY_URL: proxyUrl }));
  const main = readFileSync(join(packaged.appResources, "app", "main.cjs"), "utf8");
  if (!main.includes("requestSingleInstanceLock") || !main.includes("/api/v1/notification-deliveries/claim")) {
    throw new TypeError("package contract invalid");
  }
  const happy = await runPackage(packaged.executable, { args: [],
    expected: "TASK33_PACKAGED_ELECTRON_HAPPY_PASS claims=2 shows=1 settles=1", streamName: "stdout" });
  const metrics = /claims=(\d+) shows=(\d+) settles=(\d+)/u.exec(happy);
  const claims = Number(metrics?.[1]); const shows = Number(metrics?.[2]); const settles = Number(metrics?.[3]);
  if (!(claims === 2 && shows === 1 && settles === 1) || requests.claims !== 2 || requests.settles !== 1
    || requests.events < 1) throw new TypeError("adapter effects invalid");
  const measured = { ...requests };
  const after = counts();
  const unexpected = tables.filter(name => name !== "notification_deliveries" && after[name] !== before[name]);
  const delivery = db.db.prepare("SELECT state FROM notification_deliveries").get();
  const intent = db.db.prepare("SELECT state FROM notification_intents WHERE intent_id='ntf:pos:v1:driver'").get();
  if (after.notification_deliveries - before.notification_deliveries !== 1 || unexpected.length !== 0
    || delivery?.state !== "delivered" || intent?.state !== "delivered") throw new TypeError("authority deltas invalid");
  await runPackage(packaged.executable, { args: ["--help"], expected: "TASK33_PACKAGED_ELECTRON_HELP_PASS", streamName: "stdout" });
  await runPackage(packaged.executable, { args: ["jarvis://evil/today"],
    expected: "ELECTRON_DEEP_LINK_INVALID", streamName: "stderr" });
  process.stdout.write("TASK33_TABLE_DELTAS_PASS unexpected_tables=0\n");
  process.stdout.write(`TASK33_EFFECT_DELTAS_PASS claims=${measured.claims} shows=${shows}`
    + ` settles=${measured.settles} sse=${measured.events} unauthorized_effects=0\n`);
  process.stdout.write(`TASK33_PACKAGED_ELECTRON_HAPPY_PASS claims=${claims} shows=${shows} settles=${settles}\n`);
  process.stdout.write("TASK33_PACKAGED_ELECTRON_HELP_PASS\nTASK33_PACKAGED_ELECTRON_BAD_PATHS_PASS\n");
  process.stdout.write("TASK33_NOTIFICATION_DRIVER_PASS\n");
} finally {
  proxy?.closeAllConnections(); proxy?.close(); server?.close(); db.close(); rmSync(root, { recursive: true, force: true });
}
