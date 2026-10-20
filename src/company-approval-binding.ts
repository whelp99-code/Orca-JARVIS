import { randomUUID } from "node:crypto";
import { canonicalize } from "./canonical.js";
import {
  companyApprovalBindingDigest, companyApprovalReceiptSchema, companyPublicKeyFingerprint, parseCompanyApprovalBinding,
  type CompanyApprovalBinding,
} from "./company-approver-contract.js";
import { decodeCompanyCommandV2, type CompanyCommandV2 } from "./company-candidate-v2-contract.js";
import {
  companyCheckpointSchema, freshnessReadResponseSchema,
  type CompanyFreshnessProvider,
} from "./company-freshness.js";
import { controlCommandDigest, verifyCommandApproval, type CommandApprovalReceipt } from "./control-plane-contract.js";
import type { AuthorityDb } from "./db.js";
import { JarvisError } from "./jarvis-error.js";
import { assertCompanyLocalProgress, companyOtherStorePrefix } from "./company-local-progress.js";

type Scope = { provider_instance_id: string; workspace_id: string };
type TrustedKey = { key_id: string; principal_id: string; public_key_pem: string };

export function readCompanyApprovalBinding(db: AuthorityDb, scope: Scope): CompanyApprovalBinding | undefined {
  const row = db.db.prepare(
    "SELECT binding_json,binding_digest FROM company_approval_bindings WHERE provider_instance_id=? AND workspace_id=?",
  ).get(scope.provider_instance_id, scope.workspace_id) as { binding_json: string; binding_digest: string } | undefined;
  if (!row) return undefined;
  const binding = parseCompanyApprovalBinding(JSON.parse(row.binding_json));
  if (companyApprovalBindingDigest(binding) !== row.binding_digest
    || binding.provider_instance_id !== scope.provider_instance_id || binding.workspace_id !== scope.workspace_id) {
    throw new JarvisError("ENROLLMENT_REQUIRED");
  }
  return binding;
}

function assertBindingKeys(db: AuthorityDb, binding: CompanyApprovalBinding, onlyKeyId?: string): void {
  const pins = onlyKeyId === undefined ? binding.approver_keys : binding.approver_keys.filter(key => key.key_id === onlyKeyId);
  if ([binding.approver_principal_id, companyApprovalBindingDigest(binding), ...pins.map(key => key.key_id)]
    .some(reference => db.db.prepare("SELECT 1 FROM authority_revocations WHERE reference=?").get(reference))) {
    throw new JarvisError("COMPANY_APPROVAL_REVOKED");
  }
  const all = db.db.prepare("SELECT key_id,principal_id,public_key_pem FROM trusted_authority_keys").all() as TrustedKey[];
  for (const pin of pins) {
    const key = all.find(candidate => candidate.key_id === pin.key_id);
    const purpose = db.db.prepare("SELECT 1 FROM authority_key_purposes WHERE key_id=? AND purpose='decision'").get(pin.key_id);
    if (!key || !purpose || key.principal_id !== binding.approver_principal_id
      || companyPublicKeyFingerprint(key.public_key_pem) !== pin.public_key_fingerprint) {
      throw new JarvisError("COMPANY_APPROVAL_INVALID");
    }
    for (const candidate of all) {
      if (candidate.key_id !== pin.key_id
        && companyPublicKeyFingerprint(candidate.public_key_pem) === pin.public_key_fingerprint) {
        throw new JarvisError("COMPANY_APPROVAL_INVALID");
      }
    }
  }
}

/** Local registration consumes independently validated freshness, never a command-supplied policy. */
export function registerCompanyApprovalBinding(
  db: AuthorityDb, value: unknown, checkpointValue: unknown, provider: CompanyFreshnessProvider, now = new Date(),
): void {
  const binding = parseCompanyApprovalBinding(value);
  const parsed = companyCheckpointSchema.safeParse(checkpointValue);
  if (!parsed.success || !Number.isFinite(now.getTime())) throw new JarvisError("COMPANY_CONTRACT_INVALID");
  const checkpoint = parsed.data;
  const bindingDigest = companyApprovalBindingDigest(binding);
  if (checkpoint.approval_binding_digest !== bindingDigest
    || checkpoint.approval_policy_version !== binding.approval_policy_version) throw new JarvisError("ENROLLMENT_REQUIRED");
  if (db.db.inTransaction) throw new JarvisError("COMPANY_FRESHNESS_REQUIRED");
  const scope = { provider_instance_id: binding.provider_instance_id, workspace_id: binding.workspace_id };
  const preflight = () => {
    if (readCompanyApprovalBinding(db, binding)) throw new JarvisError("ENROLLMENT_REQUIRED");
    const legacy = db.db.prepare(
      `SELECT 1 FROM control_command_requests WHERE action='company.candidate.transition'
       AND json_extract(target_json,'$.provider_instance_id')=? AND json_extract(target_json,'$.workspace_id')=? LIMIT 1`,
    ).get(binding.provider_instance_id, binding.workspace_id);
    if (legacy) throw new JarvisError("ENROLLMENT_REQUIRED");
    assertBindingKeys(db, binding);
    if (provider.kind === "sb_company_db") assertCompanyLocalProgress(db, scope, checkpoint);
  };
  preflight();
  const challenge = randomUUID();
  let raw: unknown;
  try {
    raw = provider.readFreshness({ schema_version: 2, scope, installation_id: "installation:jarvis", challenge, observed_checkpoint: checkpoint });
  } catch { throw new JarvisError("COMPANY_FRESHNESS_REQUIRED"); }
  const response = freshnessReadResponseSchema.safeParse(raw);
  if (!response.success || response.data.challenge !== challenge
    || canonicalize(response.data.scope) !== canonicalize(scope)) throw new JarvisError("COMPANY_FRESHNESS_REQUIRED");
  if (response.data.status === "mismatch") throw new JarvisError("COMPANY_OPERATIONAL_ROLLBACK");
  if (response.data.status !== "ready") throw new JarvisError("COMPANY_FRESHNESS_REQUIRED");
  const selected = response.data.checkpoint;
  if (canonicalize(selected) !== canonicalize(checkpoint)
    && (provider.kind !== "sb_company_db" || !companyOtherStorePrefix(checkpoint, selected))) {
    throw new JarvisError("COMPANY_FRESHNESS_REQUIRED");
  }
  db.db.transaction(() => {
    preflight();
    db.db.prepare(
      "INSERT INTO company_approval_bindings(provider_instance_id,workspace_id,binding_json,binding_digest,registered_at) VALUES(?,?,?,?,?)",
    ).run(binding.provider_instance_id, binding.workspace_id, canonicalize(binding), bindingDigest, now.toISOString());
    db.db.prepare(
      "INSERT INTO company_freshness_checkpoints(provider_instance_id,workspace_id,checkpoint_json,updated_at) VALUES(?,?,?,?)",
    ).run(binding.provider_instance_id, binding.workspace_id, canonicalize(selected), now.toISOString());
  }).immediate();
}

/** Current policy/key/revocation checks for evidence lookup. This does not authorize a new effect. */
export function assertCompanyApprovalPin(db: AuthorityDb, value: CompanyCommandV2, approval: CommandApprovalReceipt): void {
  const command = decodeCompanyCommandV2(value);
  if (!companyApprovalReceiptSchema.safeParse(approval).success) throw new JarvisError("COMPANY_APPROVAL_INVALID");
  const binding = readCompanyApprovalBinding(db, command.target);
  if (!binding || companyApprovalBindingDigest(binding) !== command.args.approval_binding_digest
    || binding.owner !== command.args.owner || binding.processor_principal_id !== command.args.processor_principal_id
    || binding.approver_principal_id !== command.args.approver_principal_id
    || binding.approval_policy_version !== command.args.approval_policy_version) throw new JarvisError("ENROLLMENT_REQUIRED");
  assertBindingKeys(db, binding, approval.key_id);
  const pin = binding.approver_keys.find(key => key.key_id === approval.key_id);
  const key = db.db.prepare("SELECT key_id,principal_id,public_key_pem FROM trusted_authority_keys WHERE key_id=?")
    .get(approval.key_id) as TrustedKey | undefined;
  if (!pin || !key || key.principal_id !== binding.approver_principal_id
    || approval.signer_principal_id !== binding.approver_principal_id
    || approval.request_id !== command.request_id || approval.command_digest !== controlCommandDigest(command)
    || !["approve", "reject"].includes(approval.decision)
    || Date.parse(approval.not_before) < Date.parse(approval.issued_at)
    || Date.parse(approval.expires_at) > Date.parse(command.expires_at)
    || !verifyCommandApproval(approval, key.public_key_pem, new Date(approval.not_before))) {
    throw new JarvisError("COMPANY_APPROVAL_INVALID");
  }
  const references = [command.request_id, controlCommandDigest(command), approval.receipt_id,
    approval.key_id, approval.signer_principal_id, command.args.approval_binding_digest];
  if (references.some(reference => db.db.prepare("SELECT 1 FROM authority_revocations WHERE reference=?").get(reference))
    || db.db.prepare("SELECT 1 FROM control_command_revocations WHERE request_id=? OR receipt_id=?")
      .get(command.request_id, approval.receipt_id)) throw new JarvisError("COMPANY_APPROVAL_REVOKED");
}

export function assertCurrentCompanyPin(
  db: AuthorityDb, command: CompanyCommandV2, approval: CommandApprovalReceipt, now: Date,
): void {
  assertCompanyApprovalPin(db, command, approval);
  const time = now.getTime();
  if (!Number.isFinite(time) || Date.parse(command.requested_at) > time || time >= Date.parse(command.expires_at)
    || Date.parse(approval.not_before) > time || time >= Date.parse(approval.expires_at)) {
    throw new JarvisError("COMPANY_APPROVAL_INVALID");
  }
}
