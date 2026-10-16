import { createHash } from "node:crypto";
import { z } from "zod";
import { canonicalize } from "./canonical.js";
import { JarvisError } from "./jarvis-error.js";
import { companyApprovalReceiptSchema } from "./company-approver-contract.js";
import { companyTargetV2Schema } from "./company-candidate-v2-contract.js";

const REQUEST_DOMAIN = "second-brain/company-memory-request/v1\0";
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const instant = z.iso.datetime({ precision: 3 });
const identifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/);

export const transitionReadArgumentsSchema = z.object({
  candidate_id: companyTargetV2Schema.shape.candidate_id,
  handoff_id: z.string().min(1).max(256),
  operation: z.enum(["accept", "reject", "mark_processed"]),
  transition_request_digest: digest,
  command_digest: digest,
  content_digest: digest,
  approval_policy_version: z.int().min(1).max(Number.MAX_SAFE_INTEGER),
  approval_binding_digest: digest,
}).strict();
export type TransitionReadArguments = z.infer<typeof transitionReadArgumentsSchema>;

const projectionSchema = z.object({
  receipt_id: z.string().min(1).max(256),
  receipt_digest: digest,
  operation: z.enum(["accept", "reject", "mark_processed"]),
  state: z.enum(["accepted", "rejected", "processed_complete"]),
  handoff_id: z.string().min(1).max(256),
  receipt_created_at: instant,
  decision_at: instant,
  accepted_at: instant.nullable(),
}).strict();
export type TransitionReceiptProjection = z.infer<typeof projectionSchema>;

export const transitionReadResponseSchema = z.object({
  schema_version: z.literal(2),
  provider_instance_id: identifier,
  workspace_id: z.uuid(),
  selector: transitionReadArgumentsSchema,
  lookup_nonce: z.string().min(1).max(256),
  lookup_request_digest: digest,
  outcome: z.enum(["found", "not_found", "evidence_absent"]),
  receipt: z.union([projectionSchema, z.null()]),
}).strict();
export type TransitionReadResponse = z.infer<typeof transitionReadResponseSchema>;

export type TransitionReadExpectation = {
  provider_instance_id: string;
  workspace_id: string;
  selector: Record<string, unknown>;
  lookup_nonce: string;
  lookup_request_digest: string;
};

export function transitionRequestDigest(operation: "accept" | "reject" | "mark_processed", originalArguments: Record<string, unknown>): string {
  if (operation === "mark_processed") {
    const parsed = z.object({
      candidate_id: transitionReadArgumentsSchema.shape.candidate_id,
      handoff_id: transitionReadArgumentsSchema.shape.handoff_id,
    }).strict().safeParse(originalArguments);
    if (!parsed.success) throw new JarvisError("COMPANY_CONTRACT_INVALID");
    return companyMemoryRequestDigest(operation, parsed.data);
  }
  const parsed = z.object({
    candidate_id: transitionReadArgumentsSchema.shape.candidate_id,
    handoff_id: transitionReadArgumentsSchema.shape.handoff_id,
    approval: companyApprovalReceiptSchema,
  }).strict().safeParse(originalArguments);
  if (!parsed.success || parsed.data.approval.request_id !== parsed.data.handoff_id
    || parsed.data.approval.decision !== (operation === "accept" ? "approve" : "reject")) {
    throw new JarvisError("COMPANY_CONTRACT_INVALID");
  }
  return companyMemoryRequestDigest(operation, parsed.data);
}

export function companyMemoryRequestDigest(operation: string, args: Record<string, unknown>): string {
  return `sha256:${createHash("sha256").update(REQUEST_DOMAIN).update(canonicalize({ operation, arguments: args })).digest("hex")}`;
}

function fail(code: string): never {
  throw new JarvisError(code);
}

function projectionMatches(receipt: TransitionReceiptProjection, selector: TransitionReadArguments): boolean {
  if (receipt.operation !== selector.operation || receipt.handoff_id !== selector.handoff_id) return false;
  if (receipt.operation === "accept") return receipt.state === "accepted" && receipt.accepted_at !== null;
  if (receipt.operation === "mark_processed") return receipt.state === "processed_complete" && receipt.accepted_at !== null;
  return receipt.state === "rejected" && receipt.accepted_at === null;
}

export function parseTransitionReadResponse(value: unknown, expected: TransitionReadExpectation): TransitionReadResponse {
  const parsed = transitionReadResponseSchema.safeParse(value);
  if (!parsed.success) fail("COMPANY_CONTRACT_INVALID");
  const response = parsed.data;
  const selector = transitionReadArgumentsSchema.parse(expected.selector);
  if (response.provider_instance_id !== expected.provider_instance_id
    || response.workspace_id !== expected.workspace_id
    || response.lookup_nonce !== expected.lookup_nonce
    || response.lookup_request_digest !== expected.lookup_request_digest
    || canonicalize(response.selector) !== canonicalize(selector)) {
    fail("COMPANY_SB_RECEIPT_INVALID");
  }
  if (response.outcome === "found") {
    if (!response.receipt || !projectionMatches(response.receipt, selector)) fail("COMPANY_SB_RECEIPT_INVALID");
  } else if (response.receipt !== null) fail("COMPANY_CONTRACT_INVALID");
  return response;
}
