import { createPrivateKey, createPublicKey, type KeyObject } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { chmodSync, mkdtempSync, readFileSync, rmSync, watch, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { registerCompanyApprovalBinding } from "../../src/company-approval-binding.js";
import { canonicalize } from "../../src/canonical.js";
import type { CompanyContext } from "../../src/company-candidate-transport.js";
import { signCommandApproval, type CommandApprovalReceipt } from "../../src/control-plane-contract.js";
import { ControlPlane } from "../../src/control-plane.js";
import { importCompanyPage } from "../../src/company-candidate-import.js";
import { createTestOnlyMemoryProvider } from "./company-freshness.js";
import { migratedTestDatabase } from "./migrated-database.js";

const FIXTURE_PATH = fileURLToPath(new URL("../../fixtures/company-approver/company-approver-v2.test-only.json", import.meta.url));

export type CompanyApproverFixture = {
  binding: Record<string, unknown>;
  approval_binding_digest: string;
  handoff_key: string;
  command: {
    schema_version: 2;
    request_id: string;
    action: string;
    action_level: number;
    target: { provider_instance_id: string; workspace_id: string; candidate_id: string; content_digest: string };
    args: {
      owner: string;
      projects: string[];
      policy_revision: string;
      deletion_sequence: number;
      deletion_set_root: string;
      processor_principal_id: string;
      approver_principal_id: string;
      approval_policy_version: number;
      approval_binding_digest: string;
    };
    reversible: false;
    requested_by: string;
    requested_at: string;
    expires_at: string;
    nonce: string;
  };
  command_digest: string;
  approval_receipt: CommandApprovalReceipt;
  test_only_key: { test_only_private_key_pkcs8_der_hex: string; test_only_public_key_spki_der_hex: string };
  test_only_memory: { factory_input: { scope: { provider_instance_id: string; workspace_id: string }; initial_checkpoint: unknown } };
  transition_request_vectors: {
    accept: { arguments: Record<string, unknown>; transition_request_digest: string };
    reject: { arguments: Record<string, unknown>; transition_request_digest: string };
  };
};

export function companyApproverFixture(): CompanyApproverFixture {
  return JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as CompanyApproverFixture;
}

export function companyApproverKey(): KeyObject {
  return createPrivateKey({
    key: Buffer.from(companyApproverFixture().test_only_key.test_only_private_key_pkcs8_der_hex, "hex"),
    format: "der", type: "pkcs8",
  });
}

export function companyApproverProcessorContext(): CompanyContext {
  const command = companyApproverFixture().command;
  return {
    provider_instance_id: command.target.provider_instance_id,
    workspace_id: command.target.workspace_id,
    owner: command.args.owner,
    agent_id: "agent:jarvis-test",
    session_id: "session:jarvis-test",
    projects: [...command.args.projects],
    policy_revision: command.args.policy_revision,
    deletion_sequence: command.args.deletion_sequence,
    deletion_set_root: command.args.deletion_set_root,
    processor_principal_id: command.args.processor_principal_id,
  };
}

export function companyApproverRejectReceipt(): CommandApprovalReceipt {
  const fixture = companyApproverFixture();
  const issued = fixture.approval_receipt;
  return signCommandApproval({
    schema_version: 1, receipt_id: "receipt:TEST_ONLY:reject", request_id: issued.request_id,
    decision: "reject", command_digest: issued.command_digest, signer_principal_id: issued.signer_principal_id,
    authenticated_session_id: issued.authenticated_session_id, key_id: issued.key_id, algorithm: "Ed25519",
    issued_at: issued.issued_at, not_before: issued.not_before, expires_at: issued.expires_at,
    nonce: "nonce:TEST_ONLY:reject", max_uses: 1, status: "issued",
  }, companyApproverKey());
}

export async function companyApproverV2Database(decision: "approve" | "reject" = "approve", recordDecision = true) {
  const fixture = companyApproverFixture();
  const root = mkdtempSync(join(tmpdir(), "jarvis-company-v2-"));
  chmodSync(root, 0o700);
  const now = new Date(fixture.approval_receipt.not_before);
  const provider = createTestOnlyMemoryProvider(fixture.test_only_memory.factory_input as Parameters<typeof createTestOnlyMemoryProvider>[0]);
  const publicPem = createPublicKey({
    key: Buffer.from(fixture.test_only_key.test_only_public_key_spki_der_hex, "hex"),
    format: "der", type: "spki",
  }).export({ type: "spki", format: "pem" }).toString();
  const approverPath = join(root, "approver.pub.pem");
  const verifierPath = join(root, "verifier.pub.pem");
  writeFileSync(approverPath, publicPem, { mode: 0o600 });
  writeFileSync(verifierPath, createPublicKey(createPrivateKey({
    key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), Buffer.alloc(32, 5)]),
    format: "der", type: "pkcs8",
  })).export({ type: "spki", format: "pem" }), { mode: 0o600 });
  const db = await migratedTestDatabase(join(root, "authority.sqlite"));
  await db.initialize({
    decision: { keyId: fixture.approval_receipt.key_id, principal: fixture.approval_receipt.signer_principal_id, publicKeyPath: approverPath },
    verifier: { keyId: "company-verifier", principal: "principal:company-verifier", publicKeyPath: verifierPath },
  });
  const live = { db, root, close: () => { db.close(); rmSync(root, { recursive: true, force: true }); } };
  registerCompanyApprovalBinding(live.db, fixture.binding, fixture.test_only_memory.factory_input.initial_checkpoint, provider, now);
  const command = fixture.command;
  const approval = decision === "approve" ? fixture.approval_receipt : companyApproverRejectReceipt();
  const context = companyApproverProcessorContext();
  importCompanyPage(db, { handoffs: [{ idempotency_key: fixture.handoff_key, command, command_digest: fixture.command_digest }],
    count: 1, limit: 100, offset: 0 }, context, now);
  if (recordDecision) new ControlPlane(db, provider).decide(approval, now);
  return { ...live, provider, approval, command, digest: fixture.command_digest };
}

export type JarvisTestPeerMode = "ok" | "drop-once" | "bad-echo" | "drop-bad-echo" | "bad-time" | "not-found" | "evidence-absent";

export type JarvisTestPeerCounts = { accept: number; reject: number; mark_processed: number; read: number };

export async function startJarvisCompanyTestPeer(mode: JarvisTestPeerMode): Promise<{
  root: string;
  socketPath: string;
  counts: () => JarvisTestPeerCounts;
  receipts: () => string;
  close: () => Promise<void>;
}> {
  const root = mkdtempSync(join(tmpdir(), "jt-"));
  chmodSync(root, 0o700);
  const socketPath = join(root, "c.sock");
  const countPath = join(root, "counts.json");
  const readyPath = join(root, "ready");
  writeFileSync(countPath, JSON.stringify({ accept: 0, reject: 0, mark_processed: 0, read: 0 }), { mode: 0o600 });
  const script = join(root, "peer.mjs");
  writeFileSync(script, peerScript(), { mode: 0o700 });
  const ready = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("JARVIS test peer ready timeout")), 5_000);
    const watcher = watch(root, (_event, name) => {
      if (name !== "ready") return;
      clearTimeout(timer);
      watcher.close();
      resolve();
    });
  });
  const child = spawn(process.execPath, [script, socketPath, countPath, readyPath, mode], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stderr: Buffer[] = [];
  child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
  await ready;
  return {
    root, socketPath,
    counts: () => JSON.parse(readFileSync(countPath, "utf8")) as JarvisTestPeerCounts,
    receipts: () => readFileSync(`${countPath}.receipts.json`, "utf8"),
    close: () => stopPeer(child, root, stderr),
  };
}

async function stopPeer(child: ChildProcess, root: string, stderr: Buffer[]): Promise<void> {
  if (child.exitCode === null && child.signalCode === null) {
    const exited = once(child, "close", { signal: AbortSignal.timeout(1_000) });
    child.kill("SIGTERM");
    try { await exited; }
    catch {
      if (child.exitCode === null && child.signalCode === null) {
        const killed = once(child, "close", { signal: AbortSignal.timeout(5_000) });
        child.kill("SIGKILL");
        await killed;
      }
    }
  }
  rmSync(root, { recursive: true, force: true });
  if (stderr.length > 0 && child.exitCode !== 0 && child.exitCode !== null) void stderr;
}

function peerScript(): string {
  return `import { createHash } from "node:crypto";
import { createServer } from "node:net";
import { readFileSync, writeFileSync } from "node:fs";
const [socketPath, countPath, readyPath, mode] = process.argv.slice(2);
const command = ${canonicalize(companyApproverFixture().command)};
const receiptPath = countPath + ".receipts.json";
writeFileSync(receiptPath, "{}");
function canonical(value) {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value !== null && typeof value === "object") return "{" + Object.keys(value).sort().map(key => JSON.stringify(key) + ":" + canonical(value[key])).join(",") + "}";
  return JSON.stringify(value);
}
function selectorFor(operation, args) {
  return { candidate_id: args.candidate_id, handoff_id: args.handoff_id, operation,
    transition_request_digest: "sha256:" + createHash("sha256").update("second-brain/company-memory-request/v1\\0" + canonical({ operation, arguments: args })).digest("hex"),
    command_digest: args.approval.command_digest, content_digest: command.target.content_digest,
    approval_policy_version: command.args.approval_policy_version, approval_binding_digest: command.args.approval_binding_digest };
}
const counts = JSON.parse(readFileSync(countPath, "utf8"));
let dropped = false;
function digestFor(operation) {
  return createHash("sha256").update("jarvis-test-peer-" + operation).digest("hex");
}
function receipt(operation, state, acceptedAt) {
  const digest = digestFor(operation);
  return { receipt_id: "cmreceipt:v1:" + digest, receipt_digest: "sha256:" + digest, operation, state,
    handoff_id: "", receipt_created_at: "2026-10-15T00:02:00.000Z", decision_at: "2026-10-15T00:02:00.000Z", accepted_at: acceptedAt };
}
const server = createServer((socket) => {
  const chunks = [];
  socket.on("data", (chunk) => chunks.push(chunk));
  socket.on("end", () => {
    const request = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const operation = request.authority.operation;
    if (operation === "accept" || operation === "reject" || operation === "mark_processed") {
      counts[operation] += 1;
      writeFileSync(countPath, JSON.stringify(counts));
      if (operation !== "mark_processed") {
        const stored = JSON.parse(readFileSync(receiptPath, "utf8"));
        if (stored[operation]) throw new Error("duplicate test-peer effect");
        const original = receipt(operation, operation === "accept" ? "accepted" : "rejected",
          operation === "accept" ? "2026-10-15T00:02:00.000Z" : null);
        original.handoff_id = request.arguments.handoff_id;
        stored[operation] = { selector: selectorFor(operation, request.arguments), receipt: original };
        writeFileSync(receiptPath, JSON.stringify(stored));
      }
      if ((mode === "drop-once" || mode === "drop-bad-echo") && !dropped && operation !== "mark_processed") {
        dropped = true;
        socket.destroy();
        return;
      }
    }
    if (operation === "read_transition_receipt") {
      counts.read += 1;
      writeFileSync(countPath, JSON.stringify(counts));
    }
    const found = operation === "read_transition_receipt" ? request.arguments.operation : operation;
    const state = found === "accept" ? "accepted" : found === "reject" ? "rejected" : "processed_complete";
    const direct = digestFor(operation);
    const stored = operation === "read_transition_receipt"
      ? JSON.parse(readFileSync(receiptPath, "utf8"))[request.arguments.operation] : undefined;
    const exact = stored && canonical(stored.selector) === canonical(request.arguments);
    const body = operation === "mark_processed" || operation === "accept" || operation === "reject"
      ? { receipt_id: "cmreceipt:v1:" + direct, receipt_digest: "sha256:" + direct, operation, state, handoff_id: request.arguments.handoff_id }
      : operation === "read_transition_receipt"
        ? { schema_version: 2, provider_instance_id: request.authority.provider_instance_id, workspace_id: request.authority.workspace_id,
            selector: request.arguments, lookup_nonce: mode === "bad-echo" || mode === "drop-bad-echo" ? "nonce:wrong" : request.authority.nonce,
            lookup_request_digest: request.authority.request_digest,
            outcome: mode === "not-found" || !exact ? "not_found" : mode === "evidence-absent" ? "evidence_absent" : "found",
            receipt: mode === "not-found" || mode === "evidence-absent" || !exact ? null
              : { ...stored.receipt, accepted_at: mode === "bad-time" ? null : stored.receipt.accepted_at } }
        : { error: "JARVIS_TEST_PEER_UNSUPPORTED" };
    socket.end(JSON.stringify(body));
  });
});
server.listen(socketPath, () => writeFileSync(readyPath, "ready"));
`;
}
