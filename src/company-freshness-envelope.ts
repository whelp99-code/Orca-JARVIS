import { createHash, randomUUID, sign } from "node:crypto";
import { z } from "zod";
import { canonicalize } from "./canonical.js";
import { companyBrokerAuthoritySchema } from "./company-broker-authority.js";
import { companyApprovalReceiptSchema } from "./company-approver-contract.js";
import { decodeCompanyCommandV2 } from "./company-candidate-v2-contract.js";
import { companyCompletionV2Schema } from "./company-completion-v2.js";
import { companyCancellationSchema } from "./company-cancellation.js";
import {
  freshnessReadRequestSchema, reserveProgressRequestSchema, finishProgressRequestSchema,
  companyOperationId, type FinishProgressRequest,
} from "./company-freshness-contract.js";
import { controlCommandDigest, controlValueDigest } from "./control-plane-contract.js";
import type { loadCompanyFreshnessClient } from "./company-freshness-client-config.js";
import { JarvisError } from "./jarvis-error.js";

const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
export const companyFreshnessMethodSchema = z.enum(["read_freshness", "reserve_progress", "finish_progress"]);
const payloadSchema = z.object({
  schema_version: z.literal(1), method: companyFreshnessMethodSchema, request: z.unknown(), evidence: z.unknown(),
}).strict();
const evidenceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("jarvis_cancellation"), original_at: z.iso.datetime({ precision: 3 }),
    command: z.unknown(), approval: companyApprovalReceiptSchema,
    reservation: reserveProgressRequestSchema, cancellation: companyCancellationSchema }).strict(),
  z.object({ kind: z.literal("jarvis_decision"), original_at: z.iso.datetime({ precision: 3 }),
    command: z.unknown(), receipt: companyApprovalReceiptSchema }).strict(),
  z.object({
    kind: z.literal("jarvis_completion"), original_at: z.iso.datetime({ precision: 3 }),
    command: z.unknown(), approval: companyApprovalReceiptSchema,
    acceptance: z.object({
      receipt_id: z.string().min(1), receipt_digest: digest, operation: z.literal("accept"),
      state: z.literal("accepted"), handoff_id: z.string().min(1),
    }).strict(),
    completion: companyCompletionV2Schema,
  }).strict(),
]);

function invalid(): never { throw new JarvisError("COMPANY_CONTRACT_INVALID"); }

export function parseCompanyProgressEvidence(value: unknown) {
  const parsed = evidenceSchema.safeParse(value);
  if (!parsed.success) return invalid();
  const evidence = parsed.data;
  const command = decodeCompanyCommandV2(evidence.command);
  const commandDigest = controlCommandDigest(command);
  switch (evidence.kind) {
    case "jarvis_cancellation": {
      const reservation = evidence.reservation;
      const operation = evidence.approval.decision === "approve" ? "decide_approve" : "decide_reject";
      const cancellation = evidence.cancellation;
      const payload = canonicalize({ request_id: command.request_id, reason: cancellation.reason,
        revoked_by: cancellation.revoked_by, revoked_at: cancellation.revoked_at });
      if (evidence.approval.request_id !== command.request_id || evidence.approval.command_digest !== commandDigest
        || reservation.operation !== operation || reservation.event_digest !== controlValueDigest(evidence.approval)
        || reservation.scope.provider_instance_id !== command.target.provider_instance_id
        || reservation.scope.workspace_id !== command.target.workspace_id
        || reservation.operation_id !== companyOperationId({ scope: reservation.scope,
          request_id: command.request_id, command_digest: commandDigest, operation })
        || cancellation.request_id !== command.request_id || cancellation.command_digest !== commandDigest
        || cancellation.payload_json !== payload || cancellation.payload_digest !== controlValueDigest(payload)
        || evidence.original_at !== cancellation.revoked_at) return invalid();
      return { ...evidence, command };
    }
    case "jarvis_decision":
      if (evidence.receipt.request_id !== command.request_id || evidence.receipt.command_digest !== commandDigest) return invalid();
      return { ...evidence, command };
    case "jarvis_completion":
      if (evidence.approval.decision !== "approve" || evidence.approval.request_id !== command.request_id
        || evidence.approval.command_digest !== commandDigest || evidence.acceptance.handoff_id !== command.request_id
        || evidence.completion.request_id !== command.request_id || evidence.completion.command_digest !== commandDigest
        || evidence.completion.candidate_id !== command.target.candidate_id
        || evidence.completion.content_digest !== command.target.content_digest
        || evidence.completion.acceptance_receipt_digest !== evidence.acceptance.receipt_digest
        || [commandDigest, command.target.content_digest, evidence.acceptance.receipt_digest].includes(evidence.completion.effect_digest)) return invalid();
      return { ...evidence, command };
    default: {
      const exhaustive: never = evidence;
      void exhaustive;
      return invalid();
    }
  }
}

export function companyProgressSidecar(value: unknown) {
  const evidence = parseCompanyProgressEvidence(value);
  if (evidence.kind === "jarvis_cancellation") return { schema_version: 1 as const, kind: "revocation" as const,
    source_record_id: evidence.cancellation.revocation_id, original_at: evidence.original_at, command: evidence.command,
    record: { approval: evidence.approval, reservation: evidence.reservation, cancellation: evidence.cancellation } };
  return { schema_version: 1 as const,
    kind: evidence.kind === "jarvis_decision" ? "representative_receipt" as const : "completion" as const,
    source_record_id: evidence.kind === "jarvis_decision" ? evidence.receipt.receipt_id : `completion:${evidence.command.request_id}`,
    original_at: evidence.original_at, command: evidence.command,
    record: evidence.kind === "jarvis_decision" ? evidence.receipt : evidence.completion };
}

function finishEvidence(value: unknown, request: FinishProgressRequest) {
  const evidence = z.object({
    schema_version: z.literal(1), kind: z.enum(["representative_receipt", "completion", "revocation"]),
    source_record_id: z.string().min(1).max(512), original_at: z.iso.datetime({ precision: 3 }),
    command: z.unknown(), record: z.unknown(),
  }).strict().parse(value);
  const command = decodeCompanyCommandV2(evidence.command);
  const commandDigest = controlCommandDigest(command);
  let operation: "decide_approve" | "decide_reject" | "complete";
  let expectedDigest: string;
  let terminal: string;
  if (evidence.kind === "revocation") {
    const record = z.object({ approval: companyApprovalReceiptSchema, reservation: reserveProgressRequestSchema,
      cancellation: companyCancellationSchema }).strict().parse(evidence.record);
    const proof = parseCompanyProgressEvidence({ kind: "jarvis_cancellation", original_at: evidence.original_at,
      command, ...record });
    if (proof.kind !== "jarvis_cancellation" || proof.cancellation.revocation_id !== evidence.source_record_id) return invalid();
    operation = proof.reservation.operation === "decide_approve" ? "decide_approve" : "decide_reject";
    expectedDigest = proof.cancellation.payload_digest;
    terminal = "cancelled";
  } else if (evidence.kind === "representative_receipt") {
    const receipt = companyApprovalReceiptSchema.parse(evidence.record);
    if (receipt.request_id !== command.request_id || receipt.command_digest !== commandDigest
      || receipt.receipt_id !== evidence.source_record_id
      || Date.parse(evidence.original_at) < Date.parse(receipt.not_before)
      || Date.parse(evidence.original_at) >= Date.parse(receipt.expires_at)) return invalid();
    operation = receipt.decision === "approve" ? "decide_approve" : "decide_reject";
    expectedDigest = controlValueDigest(receipt);
    terminal = receipt.decision === "approve" ? "approved" : "rejected";
  } else {
    const completion = companyCompletionV2Schema.parse(evidence.record);
    if (evidence.source_record_id !== `completion:${command.request_id}`
      || completion.request_id !== command.request_id || completion.command_digest !== commandDigest
      || completion.candidate_id !== command.target.candidate_id || completion.content_digest !== command.target.content_digest
      || [commandDigest, command.target.content_digest, completion.acceptance_receipt_digest].includes(completion.effect_digest)) return invalid();
    operation = "complete"; expectedDigest = completion.effect_digest; terminal = "completed";
  }
  if (command.target.provider_instance_id !== request.scope.provider_instance_id
    || command.target.workspace_id !== request.scope.workspace_id
    || command.args.approval_binding_digest !== request.expected_checkpoint.approval_binding_digest
    || command.args.approval_policy_version !== request.expected_checkpoint.approval_policy_version
    || request.evidence_digest !== expectedDigest
    || request.terminal_state !== terminal
    || request.operation_id !== companyOperationId({
      scope: request.scope, request_id: command.request_id, command_digest: commandDigest, operation,
    })) return invalid();
  return { ...evidence, command };
}

export function parseCompanyFreshnessPayload(value: unknown) {
  const parsed = payloadSchema.safeParse(value);
  if (!parsed.success) return invalid();
  const payload = parsed.data;
  switch (payload.method) {
    case "read_freshness":
      if (payload.evidence !== null) return invalid();
      return { schema_version: 1 as const, method: payload.method, request: freshnessReadRequestSchema.parse(payload.request), evidence: null };
    case "reserve_progress": {
      const request = reserveProgressRequestSchema.parse(payload.request);
      if (payload.evidence !== null || !["decide_approve", "decide_reject", "complete"].includes(request.operation)) return invalid();
      return { schema_version: 1 as const, method: payload.method, request, evidence: null };
    }
    case "finish_progress": {
      const request = finishProgressRequestSchema.parse(payload.request);
      return { schema_version: 1 as const, method: payload.method, request, evidence: finishEvidence(payload.evidence, request) };
    }
    default: {
      const exhaustive: never = payload.method;
      void exhaustive;
      return invalid();
    }
  }
}

export type CompanyFreshnessPayload = ReturnType<typeof parseCompanyFreshnessPayload>;

export function companyFreshnessRequestDigest(payload: Pick<CompanyFreshnessPayload, "method" | "request" | "evidence">): string {
  return `sha256:${createHash("sha256").update("second-brain/company-freshness-request/v1\0")
    .update(canonicalize({ method: payload.method, request: payload.request, evidence: payload.evidence })).digest("hex")}`;
}

export function signCompanyFreshnessEnvelope(
  input: unknown, client: ReturnType<typeof loadCompanyFreshnessClient>, now = new Date(),
) {
  const payload = parseCompanyFreshnessPayload(input);
  const context = client.config.context;
  if (!Number.isFinite(now.getTime()) || payload.request.scope.provider_instance_id !== context.provider_instance_id
    || payload.request.scope.workspace_id !== context.workspace_id
    || (payload.method === "read_freshness" && payload.request.installation_id !== client.config.installation_id)) return invalid();
  const unsigned = {
    schema_version: 1, ...context, purpose: "company_freshness_progress", operation: payload.method,
    request_digest: companyFreshnessRequestDigest(payload), issued_at: now.toISOString(),
    expires_at: new Date(now.getTime() + 60_000).toISOString(), nonce: `jarvis:progress:${randomUUID()}`,
    signing_key_id: client.config.signing_key_id,
  };
  const signature = sign(null, Buffer.from(`second-brain/company-memory-authority/v1\0${canonicalize(unsigned)}`),
    client.privateKey).toString("base64url");
  return { ...payload, authority: { ...unsigned, signature } };
}

export function parseCompanyFreshnessEnvelope(value: unknown) {
  const raw = payloadSchema.extend({ authority: companyBrokerAuthoritySchema }).safeParse(value);
  if (!raw.success) return invalid();
  const { authority, ...payload } = raw.data;
  const parsed = parseCompanyFreshnessPayload(payload);
  if (authority.operation !== parsed.method || authority.purpose !== "company_freshness_progress"
    || authority.principal_id !== "principal:jarvis-company-progress"
    || authority.provider_instance_id !== parsed.request.scope.provider_instance_id
    || authority.workspace_id !== parsed.request.scope.workspace_id
    || authority.request_digest !== companyFreshnessRequestDigest(parsed)) return invalid();
  return { ...parsed, authority };
}
