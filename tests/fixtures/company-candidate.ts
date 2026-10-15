import { createHash, createPrivateKey, createPublicKey, type KeyObject } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migratedTestDatabase } from "./migrated-database.js";
import { companyHandoffKey, type CompanyCommand } from "../../src/company-candidate-contract.js";
import { controlCommandDigest, signCommandApproval, type CommandApprovalReceipt } from "../../src/control-plane-contract.js";
import type { CompanyClient, CompanyContext, CompanyOperation } from "../../src/company-candidate-transport.js";
import type { CompanySbReceipt } from "../../src/company-candidate-execution.js";
import type { AuthorityDb } from "../../src/db.js";

export const COMPANY_NOW = new Date("2026-10-13T00:00:00.000Z");
const fixedKey = (byte: number) => createPrivateKey({
  key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), Buffer.alloc(32, byte)]),
  type: "pkcs8", format: "der",
});
export const COMPANY_OWNER_KEY = fixedKey(4);
export const COMPANY_PROCESSOR_KEY = fixedKey(3);
export const COMPANY_CONTEXT: CompanyContext = {
  provider_instance_id: "sb-company-test",
  workspace_id: "42424242-4242-4242-8242-424242424242",
  owner: "principal:company-owner", agent_id: "agent:company", session_id: "company-session",
  projects: ["project:company"], policy_revision: "policy:company:v1",
  deletion_sequence: 0, deletion_set_root: `sha256:${"0".repeat(64)}`,
  processor_principal_id: "principal:company-processor",
};

export function companyProposal(candidateId = "company-fixture-1", now = COMPANY_NOW, generation = 1, context = COMPANY_CONTEXT) {
  const target = {
    provider_instance_id: context.provider_instance_id, workspace_id: context.workspace_id,
    candidate_id: candidateId, content_digest: `sha256:${"a".repeat(64)}`,
  };
  const args = {
    owner: context.owner, projects: [...context.projects], policy_revision: context.policy_revision,
    deletion_sequence: context.deletion_sequence, deletion_set_root: context.deletion_set_root,
    processor_principal_id: context.processor_principal_id,
    operations: ["accept", "reject", "mark_processed"] as ["accept", "reject", "mark_processed"],
  };
  const key = companyHandoffKey({ target, args });
  const command: CompanyCommand = {
    schema_version: 1, request_id: `${key}:${generation}`, action: "company.candidate.transition", action_level: 3,
    target, args, reversible: false, requested_by: args.owner, requested_at: now.toISOString(),
    expires_at: new Date(now.getTime() + 86_400_000).toISOString(), nonce: `${key}:${generation}`,
  };
  return { idempotency_key: key, command, command_digest: controlCommandDigest(command) };
}

export function companyPage(...items: ReturnType<typeof companyProposal>[]) {
  return { handoffs: items, count: items.length, limit: 100, offset: 0 };
}

export function companyApproval(proposal: ReturnType<typeof companyProposal>, decision: "approve" | "reject" = "approve",
  overrides: Partial<Omit<CommandApprovalReceipt, "signature">> = {}, key: KeyObject = COMPANY_OWNER_KEY) {
  const at = proposal.command.requested_at;
  return signCommandApproval({
    schema_version: 1, receipt_id: `owner:${proposal.command.request_id}`, request_id: proposal.command.request_id,
    decision, command_digest: proposal.command_digest, signer_principal_id: COMPANY_CONTEXT.owner,
    authenticated_session_id: "owner-passkey-session", key_id: "company-owner", algorithm: "Ed25519",
    issued_at: at, not_before: at, expires_at: new Date(Date.parse(at) + 600_000).toISOString(),
    nonce: `receipt:${proposal.command.request_id}`, max_uses: 1, status: "issued", ...overrides,
  }, key);
}

export function companyReceipt(requestId: string, operation: Exclude<CompanyOperation, "handoff" | "read_transition_receipt">): CompanySbReceipt {
  const hash = createHash("sha256").update(JSON.stringify({ requestId, operation })).digest("hex");
  return { receipt_id: `cmreceipt:v1:${hash}`, receipt_digest: `sha256:${hash}`,
    operation, state: operation === "accept" ? "accepted" : operation === "reject" ? "rejected" : "processed_complete",
    handoff_id: requestId };
}

export function companyClient(call: CompanyClient["call"]): CompanyClient {
  return { context: COMPANY_CONTEXT, keyId: "processor",
    publicKeyPem: createPublicKey(COMPANY_PROCESSOR_KEY).export({ type: "spki", format: "pem" }).toString(), call };
}

export async function companyDatabase() {
  const root = mkdtempSync(join(tmpdir(), "jarvis-company-test-"));
  const owner = join(root, "owner.pub.pem"); const verifier = join(root, "verifier.pub.pem");
  writeFileSync(owner, createPublicKey(COMPANY_OWNER_KEY).export({ type: "spki", format: "pem" }), { mode: 0o600 });
  writeFileSync(verifier, createPublicKey(fixedKey(5)).export({ type: "spki", format: "pem" }), { mode: 0o600 });
  const db = await migratedTestDatabase(join(root, "authority.sqlite"));
  await db.initialize({ decision: { keyId: "company-owner", principal: COMPANY_CONTEXT.owner, publicKeyPath: owner },
    verifier: { keyId: "company-verifier", principal: "principal:company-verifier", publicKeyPath: verifier } });
  return { db, root, close: () => { db.close(); rmSync(root, { recursive: true, force: true }); } };
}

export function companyState(db: AuthorityDb, id: string) {
  return db.db.prepare("SELECT status,completion_json,lease_token FROM company_candidate_handoffs WHERE request_id=?")
    .get(id) as { status: string; completion_json: string | null; lease_token: string | null } | undefined;
}
