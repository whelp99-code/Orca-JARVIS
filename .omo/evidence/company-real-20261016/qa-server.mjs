import { createPrivateKey, createPublicKey, generateKeyPairSync } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { AuthorityDb } from "../../../dist/src/db.js";
import { createDashboardServer } from "../../../dist/src/dashboard/server.js";
import { createTestOnlyMemoryProvider } from "../../../dist/tests/fixtures/company-freshness.js";
import { registerCompanyApprovalBinding } from "../../../dist/src/company-approval-binding.js";
import { importCompanyPage } from "../../../dist/src/company-candidate-import.js";
import { controlCommandDigest } from "../../../dist/src/control-plane-contract.js";
import { CompanyDailyReportCycle } from "../../../dist/src/company-daily-report-cycle.js";
import { OwnerInbox } from "../../../dist/src/owner-inbox.js";
import { ControlReceiptSigner } from "../../../dist/src/remote-approval-signer.js";

const root = "/dev/shm/jfc.1KGFZ5/qa-server";
mkdirSync(root, { mode: 0o700 });
const base = fileURLToPath(new URL("../../../", import.meta.url));
const fixture = JSON.parse(readFileSync(join(base, "fixtures/company-approver/company-approver-v2.test-only.json"), "utf8"));
const key = createPrivateKey({ key: Buffer.from(fixture.test_only_key.test_only_private_key_pkcs8_der_hex, "hex"), format: "der", type: "pkcs8" });
const ownerPublic = join(root, "owner.pub.pem");
const verifierPublic = join(root, "verifier.pub.pem");
writeFileSync(ownerPublic, createPublicKey(key).export({ type: "spki", format: "pem" }), { mode: 0o600 });
writeFileSync(verifierPublic, generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" }), { mode: 0o600 });
const now = new Date("2026-10-16T09:00:00.000Z");
const db = new AuthorityDb(join(root, "jarvis.sqlite"));
await db.migrate();
await db.initialize({ decision: { keyId: fixture.approval_receipt.key_id,
  principal: fixture.approval_receipt.signer_principal_id, publicKeyPath: ownerPublic },
verifier: { keyId: "qa-verifier", principal: "principal:qa-verifier", publicKeyPath: verifierPublic } });
const provider = createTestOnlyMemoryProvider(fixture.test_only_memory.factory_input);
registerCompanyApprovalBinding(db, fixture.binding, fixture.test_only_memory.factory_input.initial_checkpoint, provider, now);
const command = { ...fixture.command, requested_at: "2026-10-16T08:00:00.000Z", expires_at: "2026-10-17T08:00:00.000Z" };
const context = { provider_instance_id: command.target.provider_instance_id, workspace_id: command.target.workspace_id,
  owner: command.args.owner, agent_id: "agent:qa", session_id: "session:qa", projects: command.args.projects,
  policy_revision: command.args.policy_revision, deletion_sequence: command.args.deletion_sequence,
  deletion_set_root: command.args.deletion_set_root, processor_principal_id: command.args.processor_principal_id };
importCompanyPage(db, { handoffs: [{ idempotency_key: fixture.handoff_key, command, command_digest: controlCommandDigest(command) }],
  count: 1, limit: 100, offset: 0 }, context, now);
const classes = ["contact_new", "calendar_memo", "progress_memo", "human_required", "unresolved"];
const rows = classes.map((classification, index) => ({
  candidate_id: `candidate:TEST_ONLY:${index + 1}`, classification,
  status: index < 3 ? "processed_complete" : index === 3 ? "human_required" : "uncertain",
  mail_event_ref: `mail-event:TEST_ONLY:${index + 1}`, policy_version: "1",
  processed_at: index < 3 ? "2026-10-16T08:30:00.000Z" : null,
  receipt_id: index < 3 ? `cmreceipt:v1:${String(index + 1).repeat(64)}` : null,
  error_reason: index === 4 ? "original_finish_unconfirmed" : null,
  operation_id: `sha256:${String(index + 1).repeat(64)}`, global_sequence: index + 1, counts_as_complete: index < 3,
}));
const cycle = new CompanyDailyReportCycle(db, { enabled: true,
  scope: { provider: "provider:TEST_ONLY:reports", workspace: command.target.workspace_id },
  activation_cutoff: "2026-10-15T09:00:00.000Z", source: { readPage(request) {
    return { schema_version: 1, epoch: "1", pinned_cutoff: request.cutoff_to,
      from_global_sequence: request.from_global_sequence, to_global_sequence: request.report_date === "2026-10-15" ? 0 : rows.length,
      rows: request.report_date === "2026-10-15" ? [] : rows, next_cursor: null };
  } } });
cycle.publishDue(new Date("2026-10-15T09:00:00.000Z"));
cycle.publishDue(now);
const inbox = new OwnerInbox(db, new ControlReceiptSigner(key, fixture.approval_receipt.key_id,
  fixture.approval_receipt.signer_principal_id), true, () => now, provider);
const server = createDashboardServer({ db, staticRoot: join(base, "dist/dashboard"), host: "127.0.0.1", port: 0,
  clock: () => now, ownerInbox: inbox, companyFreshness: provider,
  secondBrainProbe: { inspect: async () => ({
    executable: "missing", configuration: "missing", contract_digest: null, protocol_version: null,
    tools: null, schemas_compatible: false, status: "unavailable", doctor: "unavailable", handshake: "unavailable",
    read_authorization: "unauthorized", write_authorization: "unauthorized", data_state: "unavailable", refresh: { kind: "missing" },
  }) } });
writeFileSync("/dev/shm/jfc.1KGFZ5/qa-ready.json", JSON.stringify({
  origin: `http://127.0.0.1:${server.address.port}`, root, label: "TEST_ONLY UI fixture; no operating authority",
}), { mode: 0o600 });
console.log(`QA_READY http://127.0.0.1:${server.address.port}`);
async function close() { server.close(); await server.drain(); db.close(); process.exit(0); }
process.on("SIGTERM", () => { void close(); });
