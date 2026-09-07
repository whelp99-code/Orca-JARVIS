import { z } from "zod";
const intent = z.string().regex(/^memui:intent:v1:[0-9a-f]{64}$/);
const token = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const revision = z.string().regex(/^hmac-sha256:[0-9a-f]{64}$/);
const utf8 = (maximum: number) => z.string().trim().min(1).refine(value => Buffer.byteLength(value, "utf8") <= maximum);
export const MemorySearchSchema = z.object({ schema_version: z.literal(1), query: utf8(512),
  limit: z.number().int().min(1).max(20) }).strict();
export const MemoryDetailSchema = z.object({ schema_version: z.literal(1), record_token: token }).strict();
export const MemoryCandidateDispatchSchema = z.object({ schema_version: z.literal(1), intent_id: intent }).strict();
export const MemoryReviewedCandidateDecisionSchema = z.object({ schema_version: z.literal(2),
  intent_id: intent, operation: z.literal("remember"), decision: z.enum(["confirm", "reject"]),
  review_digest: z.string().regex(/^sha256:[0-9a-f]{64}$/) }).strict();
export const MemoryCandidateDecisionSchema = z.discriminatedUnion("operation", [
  z.object({ schema_version: z.literal(1), intent_id: intent, operation: z.literal("remember"),
    decision: z.enum(["confirm", "reject"]) }).strict(),
  z.object({ schema_version: z.literal(1), intent_id: intent, operation: z.literal("correct"),
    decision: z.enum(["confirm", "reject"]), record_token: token, record_revision: revision }).strict(),
]);
export const MemoryCorrectSchema = z.object({ schema_version: z.literal(1), intent_id: intent,
  record_token: token, record_revision: revision,
  payload: z.object({ replacement: utf8(4096) }).strict() }).strict();
export const MemoryForgetSchema = z.object({ schema_version: z.literal(1), intent_id: intent,
  record_token: token, record_revision: revision, payload: z.object({ acknowledge_irreversible: z.literal(true),
    erasure_claim: z.enum(["managed_erasure", "provider_local_suppression"]) }).strict() }).strict();
export const MemoryExportSchema = z.object({ schema_version: z.literal(1), intent_id: intent,
  record_token: token, record_revision: revision,
  payload: z.object({ format: z.literal("json") }).strict() }).strict();
