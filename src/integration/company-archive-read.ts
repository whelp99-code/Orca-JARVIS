import { createHash } from "node:crypto";
import { z } from "zod";
import { canonicalize } from "../canonical.js";
import { JarvisError } from "../jarvis-error.js";

const text = z.string().min(1);
const digest = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const locator = z.record(z.string(), z.union([z.string(), z.number().int().safe()]));
const requestSchema = z.object({
  arguments: z.object({ candidate_id: text }).strict().readonly(),
  authority: z.object({
    schema_version: z.literal(1), provider_instance_id: text, workspace_id: z.uuid(),
    principal_id: text, agent_id: text, session_id: text, projects: z.array(text),
    policy_revision: text, purpose: z.literal("company_memory_read"), operation: z.literal("read"),
    request_digest: digest, deletion_sequence: z.number().int().safe().nonnegative(),
    deletion_set_root: digest, issued_at: z.iso.datetime(), expires_at: z.iso.datetime(),
    nonce: text, signing_key_id: text, signature: text,
  }).strict().readonly(),
}).strict().readonly();
const receiptSchema = z.object({
  receipt: z.object({
    receipt_id: z.string().regex(/^cmreceipt:v1:[0-9a-f]{64}$/), receipt_digest: digest,
    workspace_id: z.uuid(), request_digest: digest, operation: z.literal("read"),
    candidate_id: text, created_at: z.iso.datetime(),
    result: z.object({
      workspace_id: z.uuid(), candidate_id: text, source_system: z.literal("crm"),
      source_locator: text, source_event_id: text, content: z.string().min(1).max(1_048_576),
      content_digest: digest, parser_version: z.literal("crm:normalized-archive:1"), locator,
      access: z.object({ owner: text, projects: z.array(text), policy_revision: text }).strict(),
      deletion_sequence: z.number().int().safe().nonnegative(), deletion_set_root: digest,
      state: z.literal("candidate"), accepted_at: z.null(), rejected_at: z.null(), processed_at: z.null(),
    }).strict().readonly(),
  }).strict().readonly(),
}).strict();

export type CompanyArchiveReadBinding = Readonly<{
  workspace_id: string;
  candidate_id: string;
  source_locator: string;
  source_event_id: string;
  content_digest: string;
  locator: Readonly<Record<string, string | number>>;
  provider_instance_id: string;
  principal_id: string;
  agent_id: string;
  session_id: string;
  projects: readonly string[];
  policy_revision: string;
  deletion_sequence: number;
  deletion_set_root: string;
}>;
export type CompanyArchiveReadTransport = Readonly<{
  invoke(request: Uint8Array): Promise<Readonly<{ exitCode: number; stdout: Uint8Array; stderr: Uint8Array }>>;
}>;

function nativeDigest(domain: string, value: unknown): string {
  return `sha256:${createHash("sha256").update(domain).update(canonicalize(value)).digest("hex")}`;
}

/** Explicit composition only. The native CLI verifies the supplied signed read authority.
 * The local fence rejects invalidated deliveries; it is not a grant or a Task30 read fence.
 * No signer, production config lookup, accept/process command or personal-memory fallback.
 */
export class CompanyArchiveReader {
  constructor(
    private readonly binding: CompanyArchiveReadBinding,
    private readonly transport: CompanyArchiveReadTransport,
    private readonly currentFence: () => string,
    private readonly clock: () => Date,
  ) {}

  async read(value: unknown, localFence: string) {
    const parsed = requestSchema.safeParse(value);
    if (!parsed.success) throw new JarvisError("CORE5_ARCHIVE_READ_INPUT_INVALID");
    const request = parsed.data, authority = request.authority, binding = this.binding;
    const requestDigest = nativeDigest("second-brain/company-memory-request/v1\0", {
      operation: "read", arguments: request.arguments,
    });
    if (authority.request_digest !== requestDigest || request.arguments.candidate_id !== binding.candidate_id
      || (["workspace_id", "provider_instance_id", "principal_id", "agent_id", "session_id",
        "policy_revision", "deletion_sequence", "deletion_set_root"] as const).some(
        field => authority[field] !== binding[field])
      || canonicalize(authority.projects) !== canonicalize(binding.projects)
      || binding.locator["approved"] !== "false"
      || binding.locator["authority"] !== "ARCHIVE_PROJECTION_ONLY") {
      throw new JarvisError("CORE5_ARCHIVE_READ_SCOPE_DENIED");
    }
    const issued = Date.parse(authority.issued_at), expires = Date.parse(authority.expires_at);
    const checkDelivery = () => {
      const now = this.clock().getTime();
      if (!localFence || this.currentFence() !== localFence) throw new JarvisError("CORE5_ARCHIVE_READ_FENCE_STALE");
      if (!(issued <= now && now < expires && expires <= issued + 300_000)) {
        throw new JarvisError("CORE5_ARCHIVE_READ_AUTHORITY_EXPIRED");
      }
    };
    checkDelivery();
    const response = await this.transport.invoke(Buffer.from(canonicalize(request)));
    checkDelivery();
    if (response.exitCode !== 0) throw new JarvisError("CORE5_ARCHIVE_READ_NATIVE_DENIED");
    if (response.stdout.byteLength > 1_100_000) throw new JarvisError("CORE5_ARCHIVE_READ_RECEIPT_INVALID");
    const parsedReceipt = receiptSchema.safeParse(JSON.parse(Buffer.from(response.stdout).toString("utf8")));
    if (!parsedReceipt.success) throw new JarvisError("CORE5_ARCHIVE_READ_RECEIPT_INVALID");
    const receipt = parsedReceipt.data.receipt, result = receipt.result;
    const receiptDigest = nativeDigest("second-brain/company-memory-receipt/v1\0", {
      schema_version: 1, workspace_id: receipt.workspace_id, request_digest: receipt.request_digest,
      operation: receipt.operation, candidate_id: receipt.candidate_id,
      result, created_at: receipt.created_at,
    });
    if (receipt.workspace_id !== binding.workspace_id || receipt.candidate_id !== binding.candidate_id
      || receipt.request_digest !== requestDigest || receipt.receipt_digest !== receiptDigest
      || receipt.receipt_id !== `cmreceipt:v1:${receiptDigest.slice(7)}`
      || (["workspace_id", "candidate_id", "source_locator", "source_event_id",
        "content_digest", "deletion_sequence", "deletion_set_root"] as const).some(
        field => result[field] !== binding[field])
      || `sha256:${createHash("sha256").update(result.content).digest("hex")}` !== result.content_digest
      || canonicalize(result.locator) !== canonicalize(binding.locator)
      || result.access.owner !== binding.principal_id
      || result.access.policy_revision !== binding.policy_revision
      || canonicalize(result.access.projects) !== canonicalize(binding.projects)) {
      throw new JarvisError("CORE5_ARCHIVE_READ_RECEIPT_MISMATCH");
    }
    return receipt;
  }
}
