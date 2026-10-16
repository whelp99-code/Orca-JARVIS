import assert from "node:assert/strict";
import { createHash, createPublicKey, generateKeyPairSync, randomUUID } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, readFileSync, realpathSync, writeFileSync, watch } from "node:fs";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { AuthorityDb } from "../../../dist/src/db.js";
import { registerCompanyApprovalBinding, readCompanyApprovalBinding } from "../../../dist/src/company-approval-binding.js";
import { loadCompanyFreshness } from "../../../dist/src/company-freshness.js";
import { createCompanyClient } from "../../../dist/src/company-candidate-transport.js";
import { pullCompanyCandidates } from "../../../dist/src/company-candidate-import.js";
import { signCommandApproval } from "../../../dist/src/control-plane-contract.js";
import { ControlPlane } from "../../../dist/src/control-plane.js";
import { CompanyCandidateExecutor } from "../../../dist/src/company-candidate-execution.js";
import { createCompanyCompletionVerifierV2 } from "../../../dist/src/company-completion-v2.js";

const root = process.argv[2];
const decision = process.argv[3] ?? "approve";
assert.ok(["/dev/shm/jfc.1KGFZ5/real-human", "/dev/shm/jfc.1KGFZ5/real-human-reject"].includes(root));
assert.ok(["approve", "reject"].includes(decision));
const meta = JSON.parse(readFileSync(join(root, "integration.json"), "utf8"));
const json = (path, value) => writeFileSync(path, JSON.stringify(value), { mode: 0o600 });
const base = fileURLToPath(new URL("../../../", import.meta.url));
const harness = fileURLToPath(new URL("./sb-cli-harness.py", import.meta.url));
const binary = join(root, "actual-sb-company");
writeFileSync(binary, `#!/bin/sh\nexec /home/jm/orca/projects/second-brain-app/.venv/bin/python -B '${harness}' "$@"\n`, { mode: 0o700 });
const children = [];
async function start(role) {
  const socket = join(root, `${role}.sock`);
  const config = join(root, `${role}-broker.json`);
  json(config, { schema_version: 1, role, socket, sb_company_bin: binary, sb_config_file: meta.config,
    ...(role === "processor" ? { freshness_config_file: meta.config } : {}) });
  const ready = join(root, `${role}.${randomUUID()}.ready`);
  let child;
  const listening = new Promise((resolve, reject) => {
    const watcher = watch(root, (_event, name) => {
      if (name === ready.slice(root.length + 1) && existsSync(ready)) { clearTimeout(timer); watcher.close(); resolve(); }
    });
    const timer = setTimeout(() => { watcher.close(); reject(new Error("actual broker readiness timeout")); }, 5_000);
    child = spawn(process.execPath, [join(base, "dist/tests/fixtures/company-freshness-broker-worker.mjs"), config, ready],
      { stdio: ["ignore", "ignore", "pipe"] });
    child.stderr.on("data", data => process.stderr.write(data));
    child.once("exit", code => { if (code !== null && code !== 0) { clearTimeout(timer); watcher.close(); reject(new Error(`broker exit ${code}`)); } });
  });
  children.push(child);
  await listening;
  return socket;
}
let db;
try {
  const handoffSocket = await start("handoff");
  const processorSocket = await start("processor");
  for (const [role, socket, keyId] of [["handoff", handoffSocket, "receive"], ["processor", processorSocket, "processor"]]) {
    json(join(root, `${role}-client.json`), { schema_version: 1, role, socket, context: meta.context,
      signing_key_id: keyId, signing_key_file: join(root, `${role}.pem`) });
  }
  // SB's source fixture key id is read from the pinned config, never guessed.
  const sb = JSON.parse(readFileSync(meta.config, "utf8"));
  const handoffKey = Object.entries(sb.key_scopes).find(([, scope]) => scope.operations.includes("handoff"))[0];
  const handoffConfig = JSON.parse(readFileSync(join(root, "handoff-client.json"), "utf8"));
  json(join(root, "handoff-client.json"), { ...handoffConfig, signing_key_id: handoffKey });
  json(join(root, "progress-client.json"), { schema_version: 2, role: "freshness",
    installation_id: "install:human-test", socket: processorSocket, signing_key_id: "progress:TEST_ONLY",
    signing_key_file: join(root, "progress.pem"), context: {
      provider_instance_id: meta.context.provider_instance_id, workspace_id: meta.context.workspace_id,
      principal_id: "principal:jarvis-company-progress", agent_id: meta.context.agent_id,
      session_id: meta.context.session_id, projects: meta.context.projects,
      policy_revision: meta.context.policy_revision, deletion_sequence: meta.context.deletion_sequence,
      deletion_set_root: meta.context.deletion_set_root,
    } });
  const ownerPublic = join(root, "owner.pub.pem");
  writeFileSync(ownerPublic, createPublicKey(readFileSync(join(root, "owner.pem"))).export({ type: "spki", format: "pem" }), { mode: 0o600 });
  const verifierPublic = join(root, "verifier.pub.pem");
  if (!existsSync(verifierPublic)) writeFileSync(verifierPublic,
    generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" }), { mode: 0o600 });
  db = new AuthorityDb(join(root, "jarvis.sqlite"));
  await db.migrate();
  await db.initialize({ decision: { keyId: "owner", principal: meta.binding.approver_principal_id, publicKeyPath: ownerPublic },
    verifier: { keyId: "verifier:TEST_ONLY", principal: "principal:verifier:TEST_ONLY", publicKeyPath: verifierPublic } });
  const provider = loadCompanyFreshness({ schema_version: 2, kind: "sb_company_db",
    client_config_file: join(root, "progress-client.json") }, db);
  if (!readCompanyApprovalBinding(db, meta.binding)) registerCompanyApprovalBinding(db, meta.binding, meta.checkpoint, provider);
  const imported = await pullCompanyCandidates(db, createCompanyClient(join(root, "handoff-client.json"), "handoff"), 100);
  const row = db.db.prepare("SELECT request_id FROM company_candidate_handoffs WHERE current=1").get();
  assert.ok(row);
  const control = new ControlPlane(db, provider);
  const command = control.get(row.request_id);
  assert.ok(command);
  if (command.state === "pending") {
    const now = new Date();
    const approval = signCommandApproval({ schema_version: 1, receipt_id: `receipt:TEST_ONLY:${randomUUID()}`,
      request_id: command.request_id, decision, command_digest: command.command_digest,
      signer_principal_id: meta.binding.approver_principal_id, authenticated_session_id: "TEST_ONLY:actual-human",
      key_id: "owner", algorithm: "Ed25519", issued_at: now.toISOString(), not_before: now.toISOString(),
      expires_at: new Date(Math.min(now.getTime() + 600_000, Date.parse(command.expires_at))).toISOString(),
      nonce: `TEST_ONLY:${randomUUID()}`, max_uses: 1, status: "issued" }, readFileSync(join(root, "owner.pem")));
    control.decide(approval);
  }
  const pinnedNode = join(root, "pinned-node");
  if (!existsSync(pinnedNode)) {
    copyFileSync(realpathSync(process.execPath), pinnedNode); chmodSync(pinnedNode, 0o700);
  }
  assert.equal(createHash("sha256").update(readFileSync(pinnedNode)).digest("hex"),
    createHash("sha256").update(readFileSync(realpathSync(process.execPath))).digest("hex"));
  json(join(root, "completion.json"), { schema_version: 2, executable: pinnedNode,
    args: [fileURLToPath(new URL("./verified-effect.mjs", import.meta.url)), join(root, "real-effect.txt")] });
  const executor = new CompanyCandidateExecutor(db, createCompanyClient(join(root, "processor-client.json"), "processor"),
    createCompanyCompletionVerifierV2(join(root, "completion.json")), () => new Date(), provider);
  const execution = await executor.execute(row.request_id);
  assert.equal(execution.state, decision === "approve" ? "completed" : "rejected");
  const repeated = await executor.execute(row.request_id);
  assert.equal(repeated.state, decision === "approve" ? "completed" : "rejected");
  const progress = db.db.prepare("SELECT operation,count(*) AS n FROM company_progress_reservations GROUP BY operation ORDER BY operation").all();
  assert.deepEqual(progress, decision === "approve"
    ? [{ operation: "complete", n: 1 }, { operation: "decide_approve", n: 1 }] : [{ operation: "decide_reject", n: 1 }]);
  const outbox = db.db.prepare("SELECT evidence_kind,acknowledged FROM company_progress_evidence_outbox ORDER BY evidence_kind").all();
  assert.ok(outbox.every(row => row.acknowledged === 1));
  console.log(JSON.stringify({ label: meta.label, imported, execution, repeated, jarvis_owned_reservations: progress,
    original_evidence: outbox, effect_sha256: decision === "approve"
      ? createHash("sha256").update(readFileSync(join(root, "real-effect.txt"))).digest("hex") : null }));
} finally {
  db?.close();
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) {
      const exit = once(child, "close"); child.kill("SIGTERM"); await exit;
    }
  }
}
