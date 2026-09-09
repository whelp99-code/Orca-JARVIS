// Usage: node scripts/packaged-dashboard-http-probe.mjs PACKAGE_ROOT [RECEIPT_PATH]
// Starts only the supplied package, with a private database and no inherited provider configuration.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createTestEnvironment } from "./lib/test-environment.mjs";

assert.ok(process.argv[2], "PACKAGE_ROOT required");
const root = resolve(process.argv[2]);
const receipt = JSON.parse(readFileSync(join(root, "runtime-package-receipt.json"), "utf8"));
const scratch = createTestEnvironment({ PATH: process.env.PATH });
let child;
let stopped;
try {
  const dbPath = join(scratch.root, "authority.sqlite");
  const init = spawnSync(process.execPath, ["--input-type=module", "-e",
    `import { AuthorityDb } from ${JSON.stringify(pathToFileURL(join(root, "dist/src/db.js")).href)};
     const db = new AuthorityDb(process.argv[1]); try { await db.migrate(); } finally { db.close(); }`, dbPath],
  { cwd: root, env: scratch.env, encoding: "utf8", timeout: 30000 });
  assert.equal(init.status, 0, init.stderr);
  child = spawn(process.execPath, [join(root, "dist/src/dashboard/main.js"), "--host", "127.0.0.1",
    "--port", "0", "--db", dbPath, "--static-root", join(root, "dist/dashboard")],
  { cwd: root, env: scratch.env, stdio: ["ignore", "pipe", "pipe"] });
  stopped = new Promise(resolveExit => child.once("close", (code, signal) => resolveExit({ code, signal })));
  let stderr = "";
  child.stderr.on("data", chunk => { stderr = (stderr + chunk).slice(-8192); });
  const origin = await new Promise((resolveReady, reject) => {
    let stdout = "";
    const timer = setTimeout(() => reject(new Error(`dashboard readiness timeout: ${stderr}`)), 15000);
    const finish = (error, value) => { clearTimeout(timer); error ? reject(error) : resolveReady(value); };
    child.once("error", error => finish(error));
    child.once("exit", code => finish(new Error(`dashboard exited ${code}: ${stderr}`)));
    child.stdout.on("data", chunk => {
      stdout = (stdout + chunk).slice(-8192);
      const match = stdout.match(/^http:\/\/127\.0\.0\.1:\d+$/m);
      if (match) finish(undefined, match[0]);
    });
  });
  const responses = [];
  const get = async path => {
    const response = await fetch(`${origin}${path}`, { signal: AbortSignal.timeout(10000), redirect: "error" });
    const body = Buffer.from(await response.arrayBuffer());
    assert.equal(response.status, 200, `${path}: ${body.toString().slice(0, 500)}`);
    responses.push({ path, status: response.status, bytes: body.length });
    return body;
  };
  const html = await get("/");
  assert.deepEqual(html, readFileSync(join(root, "dist/dashboard/index.html")));
  const assets = [...html.toString().matchAll(/(?:src|href)="(\/assets\/[^"?]+)"/g)].map(match => match[1]);
  assert.ok(assets.some(path => path.endsWith(".js")));
  assert.ok(assets.some(path => path.endsWith(".css")));
  for (const asset of assets) {
    assert.ok(!asset.includes(".."));
    assert.deepEqual(await get(asset), readFileSync(join(root, "dist/dashboard", asset)));
  }
  const health = JSON.parse((await get("/api/v1/health")).toString());
  assert.ok(health !== null && typeof health === "object");
  assert.equal(health.status, "ok");
  assert.equal(health.authority, "ready");
  const session = JSON.parse((await get("/api/v1/session")).toString());
  assert.equal(typeof session.csrf_token, "string");
  const previewPath = "/api/v1/proposals/preview";
  const requirements = { work_type: "development", constraints: ["no deployment"],
    completion_evidence: ["packaged HTTP preview"] };
  const preview = await fetch(`${origin}${previewPath}`, {
    method: "POST", redirect: "error", signal: AbortSignal.timeout(10000),
    headers: { origin, "content-type": "application/json", "x-jarvis-csrf": session.csrf_token },
    body: JSON.stringify({ schema_version: 1, objective: "Verify the packaged proposal route",
      ...requirements, answers: [], requested_capabilities: [] }),
  });
  const previewBody = Buffer.from(await preview.arrayBuffer());
  assert.equal(preview.status, 200, `${previewPath}: ${previewBody.toString().slice(0, 500)}`);
  const proposal = JSON.parse(previewBody.toString()).proposal;
  assert.equal(proposal.status, "ready");
  assert.deepEqual(proposal.requirements, requirements);
  assert.match(proposal.proposal_digest, /^sha256:[a-f0-9]{64}$/);
  responses.push({ path: previewPath, method: "POST", status: preview.status, bytes: previewBody.length });
  child.kill("SIGTERM");
  const forceTimer = setTimeout(() => child.kill("SIGKILL"), 5000);
  let exit;
  try { exit = await stopped; } finally { clearTimeout(forceTimer); }
  assert.equal(exit.code, 0, stderr);
  assert.equal(exit.signal, null);
  const result = { scope: "packaged dashboard HTTP with private migrated DB; no browser or provider execution",
    package_root: root, source: receipt.source, responses, static_bytes_match: true,
    proposal_preview: "ready", shutdown: exit,
    deployment_ready: false };
  if (process.argv[3]) writeFileSync(process.argv[3], `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(result));
} finally {
  if (child && child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await stopped;
  }
  scratch.cleanup();
}
