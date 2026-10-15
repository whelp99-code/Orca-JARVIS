import { createHash, createPublicKey } from "node:crypto";
import { z } from "zod";
import { canonicalize } from "./canonical.js";
import { JarvisError } from "./jarvis-error.js";

const identifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/);
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);

export const companyApprovalReceiptSchema = z.object({
  schema_version: z.literal(1),
  receipt_id: identifier,
  request_id: identifier,
  decision: z.enum(["approve", "reject"]),
  command_digest: digest,
  signer_principal_id: identifier,
  authenticated_session_id: identifier,
  key_id: identifier,
  algorithm: z.literal("Ed25519"),
  issued_at: z.iso.datetime({ precision: 3 }),
  not_before: z.iso.datetime({ precision: 3 }),
  expires_at: z.iso.datetime({ precision: 3 }),
  nonce: identifier,
  max_uses: z.literal(1),
  status: z.literal("issued"),
  signature: z.string().regex(/^[A-Za-z0-9_-]{86}$/)
    .refine(value => Buffer.from(value, "base64url").toString("base64url") === value),
}).strict();

export const companyApproverKeySchema = z.object({
  key_id: identifier,
  algorithm: z.literal("Ed25519"),
  purpose: z.literal("decision"),
  public_key_fingerprint: digest,
}).strict();

export const companyApprovalBindingSchema = z.object({
  provider_instance_id: identifier,
  workspace_id: z.uuid(),
  owner: identifier,
  processor_principal_id: identifier,
  approver_principal_id: identifier,
  approval_policy_version: z.int().min(1).max(Number.MAX_SAFE_INTEGER),
  wire_revision: z.literal(2),
  approver_keys: z.array(companyApproverKeySchema).min(1),
}).strict().refine(binding =>
  binding.owner !== binding.processor_principal_id
  && binding.approver_principal_id !== binding.owner
  && binding.approver_principal_id !== binding.processor_principal_id
  && new Set(binding.approver_keys.map(key => key.key_id)).size === binding.approver_keys.length
  && new Set(binding.approver_keys.map(key => key.public_key_fingerprint)).size === binding.approver_keys.length
  && binding.approver_keys.every((key, index, keys) => {
    const previous = keys[index - 1];
    return index === 0 || (previous !== undefined && previous.key_id < key.key_id);
  }));

export type CompanyApprovalBinding = z.infer<typeof companyApprovalBindingSchema>;

export function parseCompanyApprovalBinding(value: unknown): CompanyApprovalBinding {
  const parsed = companyApprovalBindingSchema.safeParse(value);
  if (!parsed.success) throw new JarvisError("COMPANY_CONTRACT_INVALID");
  return parsed.data;
}

export function companyApprovalBindingDigest(binding: CompanyApprovalBinding): string {
  return `sha256:${createHash("sha256")
    .update("second-brain/company-approval-binding/v1\0")
    .update(canonicalize(binding)).digest("hex")}`;
}

export function companyPublicKeyFingerprint(publicKeyPem: string): string {
  let key: ReturnType<typeof createPublicKey>;
  try { key = createPublicKey(publicKeyPem); }
  catch { throw new JarvisError("COMPANY_APPROVAL_INVALID"); }
  if (key.asymmetricKeyType !== "ed25519") throw new JarvisError("COMPANY_APPROVAL_INVALID");
  return `sha256:${createHash("sha256").update(key.export({ type: "spki", format: "der" })).digest("hex")}`;
}
