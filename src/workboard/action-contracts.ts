import { z } from "zod";

const id = z.string().min(1).max(2048);
export const operationSchema = z.enum(["approve", "reject", "stop", "resume", "redirect"]);
export type ActionOperation = z.infer<typeof operationSchema>;
export const bindingSchema = z.object({
  sourceId: id, workId: id, taskId: id, sessionId: id, attemptId: id,
  purposeVersion: z.number().int().positive(), specVersion: id,
}).strict();
export type ActionBinding = z.infer<typeof bindingSchema>;
export const requestSchema = bindingSchema.extend({
  requestId: id, revision: id, capabilityVersion: id,
  expiresAt: z.iso.datetime(), payloadDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
  payload: z.record(z.string(), z.unknown()), target: id, scope: id,
  effects: z.array(z.object({ operation: operationSchema, label: id, resumesExecution: z.boolean() }).strict()).min(1).max(5),
}).strict();
export type ActionRequest = z.infer<typeof requestSchema>;
export const receiptSchema = z.object({
  receiptId: id, intentId: id, requestId: id, requestDigest: id, operation: operationSchema,
  binding: bindingSchema,
  sourceState: z.enum(["approved", "rejected", "running", "paused", "stopped", "claimed_done", "failed"]),
  // Source completion is a claim, never verifier authority. Keep its task/spec/attempt evidence bound.
  completion: z.object({ taskId: id, specVersion: id, attemptId: id,
    acceptanceCriteria: z.array(id).min(1), evidenceRefs: z.array(id).min(1) }).strict().optional(),
}).strict();
export type ActionReceipt = z.infer<typeof receiptSchema>;
export const preparedSchema = z.object({ token: id, request: requestSchema, requiresReceipt: z.boolean() }).strict();
export type PreparedAction = z.infer<typeof preparedSchema>;
export const resultSchema = z.object({
  intentId: id, status: z.enum(["uncertain", "settled"]),
  receipt: receiptSchema.nullable(), error: z.string().nullable(),
}).strict();
export type ActionResult = z.infer<typeof resultSchema>;
export const capabilitySchema = z.object({
  available: z.boolean(), reason: z.string(), location: z.string(),
  effects: z.array(requestSchema.shape.effects.element).max(5), pending: resultSchema.nullable(),
}).strict();
export type ActionCapability = z.infer<typeof capabilitySchema>;
export type ActionSend = { intentId: string; request: ActionRequest; requestDigest: string;
  operation: ActionOperation; authorityReceipt?: unknown };
export interface WorkboardActionAdapter {
  readonly sourceId: string;
  readonly requiresReceipt: boolean;
  readonly effects: ActionRequest["effects"];
  readonly location: string;
  readRequest(workId: string): Promise<ActionRequest | null>;
  /** The source must atomically compare the exact request and consume it once. No terminal fallback. */
  send(input: ActionSend): Promise<void>;
  /** Read independently of the send ACK. null means unknown, NOT proof of non-delivery. */
  readReceipt(intentId: string, request: ActionRequest): Promise<ActionReceipt | null>;
}
