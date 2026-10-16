import { randomUUID, sign } from "node:crypto";
import { z } from "zod";
import { canonicalize } from "./canonical.js";
import { companyMemoryRequestDigest } from "./company-transition-read.js";
import type { loadCompanyFreshnessClient } from "./company-freshness-client-config.js";
import { JarvisError } from "./jarvis-error.js";

export const companyReportArgumentsSchema = z.object({
  from_global_sequence: z.int().min(0).max(Number.MAX_SAFE_INTEGER),
  to_global_sequence: z.int().min(0).max(Number.MAX_SAFE_INTEGER),
  limit: z.int().min(1).max(100),
  cursor: z.string().min(1).max(16_384).nullable(),
}).strict().refine(value => value.from_global_sequence <= value.to_global_sequence);
const inputSchema = z.discriminatedUnion("operation", [
  z.object({ schema_version: z.literal(1), operation: z.literal("auto_process_internal"),
    arguments: z.object({ limit: z.literal(100) }).strict() }).strict(),
  z.object({ schema_version: z.literal(1), operation: z.literal("read_auto_report"),
    arguments: companyReportArgumentsSchema }).strict(),
]);

/** These scopes carry no representative or policy signing capability. */
export function signCompanyInternalEnvelope(input: unknown, client: ReturnType<typeof loadCompanyFreshnessClient>,
  now = new Date()) {
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) throw new JarvisError("COMPANY_CANDIDATE_REQUEST_INVALID");
  const request = parsed.data;
  const context = client.config.context;
  const authority = {
    schema_version: 1, ...context,
    purpose: request.operation === "auto_process_internal" ? "company_internal_auto_trigger" : "company_memory_auto_report",
    operation: request.operation,
    request_digest: companyMemoryRequestDigest(request.operation, request.arguments),
    issued_at: now.toISOString(), expires_at: new Date(now.getTime() + 60_000).toISOString(),
    nonce: `jarvis:${randomUUID()}`, signing_key_id: client.config.signing_key_id,
  };
  return { authority: { ...authority, signature: sign(null, Buffer.from(
    `second-brain/company-memory-authority/v1\0${canonicalize(authority)}`), client.privateKey).toString("base64url") },
  arguments: request.arguments };
}
