#!/usr/bin/env node
import { spawn } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthorityDb } from "../dist/src/index.js";
import { createDashboardServer } from "../dist/src/dashboard/server.js";
import { packageElectronApp } from "./lib/package-electron-app.mjs";
import { parseElectronClientConfig } from "./lib/electron-shell.mjs";

const NOW = "2026-08-28T12:00:00.000Z"; const EXPIRES = "2026-08-28T13:00:00.000Z";
const RECOMMENDATION = "rec:pos:v1:driver";
const root = mkdtempSync(join(tmpdir(), "task33-driver-")); const db = new AuthorityDb(join(root, "authority.sqlite"));
let server; let proxy; let firstPackage;
function launchPackage(executable, args, userData) {
  const child = spawn(executable, ["--no-sandbox", "--disable-gpu", `--user-data-dir=${userData}`, ...args],
    { stdio: ["ignore", "pipe", "pipe"] });
  const events = new EventEmitter(); let stdout = ""; let stderr = "";
  child.stdout.on("data", chunk => { stdout += chunk.toString("utf8"); events.emit("output"); });
  child.stderr.on("data", chunk => { stderr += chunk.toString("utf8"); events.emit("output"); });
  const exited = once(child, "exit");
  const waitFor = async (expected, streamName = "stdout") => {
    const signal = AbortSignal.timeout(20_000); const value = () => streamName === "stdout" ? stdout : stderr;
    if (!value().includes(expected)) await once(events, "output", { signal });
    while (!value().includes(expected)) await once(events, "output", { signal });
  };
  return { child, exited, waitFor, stdout: () => stdout, stderr: () => stderr };
}
async function runPackage(executable, options) {
  const userData = join(root, options.expected.replaceAll(" ", "-"));
  const launched = launchPackage(executable, options.args, userData);
  try {
    await launched.waitFor(options.expected, options.streamName);
    return options.streamName === "stdout" ? launched.stdout() : launched.stderr();
  } finally {
    if (launched.child.exitCode === null) { launched.child.kill("SIGTERM"); await launched.exited; }
  }
}
function markerCount(output, marker) { return output.split(marker).length - 1; }
function observationReceipt(requests, output) {
  return { windows: markerCount(output, "TASK33_OBSERVE_WINDOW"),
    sseClients: markerCount(output, "TASK33_OBSERVE_SSE_CLIENT"),
    drains: markerCount(output, "TASK33_OBSERVE_DRAIN"), adapters: markerCount(output, "TASK33_OBSERVE_ADAPTER"),
    focus: markerCount(output, "TASK33_OBSERVE_FOCUS"), navigation: markerCount(output, "TASK33_OBSERVE_NAVIGATION"),
    show: markerCount(output, "TASK33_OBSERVE_SHOW"), resource: requests.resources, settle: requests.settles };
}
function receiptDelta(before, after) {
  return Object.fromEntries(Object.keys(before).map(key => [key, after[key] - before[key]]));
}
function recommendationDetails() {
  return { schema_version: 1, resource: "recommendation", recommendation_id: RECOMMENDATION,
    context_id: "ctx:pos:v1:driver", canonical_digest: "sha256:" + "3".repeat(64),
    evidence_digest: "sha256:" + "4".repeat(64), approval_requirement: "owner", confidence_class: "high",
    lifecycle_state: "eligible", expires_at: EXPIRES, state: "ready", actions: [{ rank: 1, title: "Review decision",
      operation: "review", target_digest: "sha256:" + "6".repeat(64), state: "pending", owner_decision_required: true,
      current: true, occurred_at: null, transition_digest: null }], evidence: [], conflicts: [], omissions: [],
    deep_links: { context_evidence: "/api/v1/contexts/driver/evidence" } };
}
function seedAuthority() {
  const digest = suffix => `sha256:${suffix.repeat(64).slice(0, 64)}`;
  const context = "ctx:pos:v1:driver"; const recommendation = RECOMMENDATION;
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
  const before = counts(); const staticRoot = join(root, "static");
  mkdirSync(staticRoot); writeFileSync(join(staticRoot, "index.html"), "<!doctype html><title>JARVIS</title>");
  server = createDashboardServer({ db, staticRoot, host: "127.0.0.1", port: 0, clock: () => new Date(NOW) });
  const authorityUrl = `http://${server.address.host}:${server.address.port}`;
  const requests = { claims: 0, settles: 0, events: 0, resources: 0 };
  proxy = createServer((incoming, outgoing) => {
    const path = incoming.url ?? "/";
    if (path === "/api/v1/notification-deliveries/claim") requests.claims += 1;
    if (path.endsWith("/settle")) requests.settles += 1;
    if (path === "/api/v1/events") requests.events += 1;
    if (path === `/api/v1/recommendations/${encodeURIComponent(RECOMMENDATION)}`) {
      requests.resources += 1; outgoing.setHeader("Content-Type", "application/json");
      outgoing.end(JSON.stringify(recommendationDetails())); return;
    }
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
  const sharedUserData = join(root, "shared-user-data");
  firstPackage = launchPackage(packaged.executable, ["--task33-driver-observe"], sharedUserData);
  const happyMarker = "TASK33_PACKAGED_ELECTRON_HAPPY_PASS claims=2 shows=1 settles=1";
  await firstPackage.waitFor(happyMarker);
  const metrics = /claims=(\d+) shows=(\d+) settles=(\d+)/u.exec(firstPackage.stdout());
  const claims = Number(metrics?.[1]); const shows = Number(metrics?.[2]); const settles = Number(metrics?.[3]);
  const initial = observationReceipt(requests, firstPackage.stdout());
  if (!(claims === 2 && shows === 1 && settles === 1) || requests.claims !== 2 || requests.settles !== 1
    || requests.events !== 1 || initial.windows !== 1 || initial.sseClients !== 1 || initial.drains !== 1
    || initial.adapters !== 1 || initial.show !== 1) throw new TypeError("adapter effects invalid");
  const validLink = "jarvis://open/recommendation?id=" + Buffer.from(RECOMMENDATION, "utf8").toString("base64url") + "&rank=1";
  const navigated = firstPackage.waitFor("TASK33_OBSERVE_NAVIGATION");
  const second = launchPackage(packaged.executable, ["--task33-driver-observe", validLink], sharedUserData);
  await second.waitFor("ELECTRON_SINGLE_INSTANCE_REDIRECTED"); const [secondExit] = await second.exited; await navigated;
  const secondRedirected = markerCount(second.stdout(), "ELECTRON_SINGLE_INSTANCE_REDIRECTED");
  const valid = observationReceipt(requests, firstPackage.stdout()); const validDelta = receiptDelta(initial, valid);
  if (!(secondExit === 0) || secondRedirected !== 1 || valid.focus !== 1 || valid.navigation !== 1 || valid.resource !== 1
    || validDelta.windows !== 0 || validDelta.sseClients !== 0 || validDelta.drains !== 0 || validDelta.adapters !== 0
    || validDelta.show !== 0 || validDelta.settle !== 0) throw new TypeError("second process invalid");
  const invalidHandled = firstPackage.waitFor("TASK33_OBSERVE_INVALID_SECOND");
  const invalidCode = firstPackage.waitFor("ELECTRON_DEEP_LINK_INVALID", "stderr");
  const malformed = launchPackage(packaged.executable, ["--task33-driver-observe", "jarvis://evil/today"], sharedUserData);
  await malformed.waitFor("ELECTRON_SINGLE_INSTANCE_REDIRECTED"); const [malformedExit] = await malformed.exited;
  await invalidHandled; await invalidCode;
  const malformedRedirected = markerCount(malformed.stdout(), "ELECTRON_SINGLE_INSTANCE_REDIRECTED");
  const malformedReceipt = observationReceipt(requests, firstPackage.stdout());
  const malformedDelta = receiptDelta(valid, malformedReceipt);
  if (malformedExit !== 0 || malformedRedirected !== 1 || malformedDelta.focus !== 0 || malformedDelta.navigation !== 0
    || malformedDelta.resource !== 0 || malformedDelta.show !== 0 || malformedDelta.settle !== 0
    || malformedDelta.windows !== 0 || malformedDelta.sseClients !== 0 || malformedDelta.drains !== 0
    || malformedDelta.adapters !== 0) throw new TypeError("malformed second process invalid");
  const measured = { ...requests };
  const after = counts();
  const unexpected = tables.filter(name => name !== "notification_deliveries" && after[name] !== before[name]);
  const delivery = db.db.prepare("SELECT state FROM notification_deliveries").get();
  const intent = db.db.prepare("SELECT state FROM notification_intents WHERE intent_id='ntf:pos:v1:driver'").get();
  if (after.notification_deliveries - before.notification_deliveries !== 1 || unexpected.length !== 0
    || delivery?.state !== "delivered" || intent?.state !== "delivered") throw new TypeError("authority deltas invalid");
  await runPackage(packaged.executable, { args: ["--help"], expected: "TASK33_PACKAGED_ELECTRON_HELP_PASS", streamName: "stdout" });
  process.stdout.write("TASK33_TABLE_DELTAS_PASS unexpected_tables=0\n");
  process.stdout.write(`TASK33_EFFECT_DELTAS_PASS claims=${measured.claims} shows=${shows}`
    + ` settles=${measured.settles} sse=${measured.events} unauthorized_effects=0\n`);
  process.stdout.write(`TASK33_PACKAGED_ELECTRON_HAPPY_PASS claims=${claims} shows=${shows} settles=${settles}\n`);
  process.stdout.write("TASK33_PACKAGED_ELECTRON_HELP_PASS\nTASK33_PACKAGED_ELECTRON_BAD_PATHS_PASS\n");
  process.stdout.write(`TASK33_REAL_SECOND_PROCESS_PASS second_exit=${secondExit} redirected=${secondRedirected}`
    + ` windows=${valid.windows}`
    + ` sse_clients=${valid.sseClients} drains=${valid.drains} adapters=${valid.adapters} focus=${valid.focus}`
    + ` navigation=${valid.navigation}\n`);
  process.stdout.write(`TASK33_REAL_MALFORMED_SECOND_PASS exit=${malformedExit} redirected=${malformedRedirected}`
    + ` focus=${malformedDelta.focus}`
    + ` navigation=${malformedDelta.navigation} resource=${malformedDelta.resource} show=${malformedDelta.show}`
    + ` settle=${malformedDelta.settle}\n`);
  process.stdout.write("TASK33_NOTIFICATION_DRIVER_PASS\n");
} finally {
  if (firstPackage?.child.exitCode === null) { firstPackage.child.kill("SIGTERM"); await firstPackage.exited; }
  proxy?.closeAllConnections(); proxy?.close(); server?.close(); db.close(); rmSync(root, { recursive: true, force: true });
}
