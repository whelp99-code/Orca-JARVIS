import { z } from "zod";
import { canonicalize } from "./canonical.js";
import { parseCompanyJson } from "./company-candidate-json.js";
import { parseCompanyProgressEvidence } from "./company-freshness-envelope.js";
import { companyOperationId } from "./company-freshness-contract.js";
import { companyCompletionV2Schema } from "./company-completion-v2.js";
import { controlCommandDigest, controlValueDigest, verifyCommandApproval, type CommandApprovalReceipt } from "./control-plane-contract.js";
import type { CompanyCommandV2 } from "./company-candidate-v2-contract.js";
import type { AuthorityDb } from "./db.js";
import { JarvisError } from "./jarvis-error.js";

const rowSchema = z.object({
  operation_id: z.string(), evidence_kind: z.enum(["jarvis_decision", "jarvis_completion"]),
  evidence_json: z.string(), evidence_digest: z.string(), acknowledged: z.union([z.literal(0), z.literal(1)]),
});
const textRow = z.object({ payload_json: z.string() });
const acceptanceSchema = z.object({
  receipt_id: z.string(), receipt_digest: z.string(), operation: z.literal("accept"),
  state: z.literal("accepted"), handoff_id: z.string(),
});
type Evidence = ReturnType<typeof parseCompanyProgressEvidence>;

function identity(evidence: Evidence) {
  const operation = evidence.kind === "jarvis_decision"
    ? evidence.receipt.decision === "approve" ? "decide_approve" : "decide_reject"
    : "complete";
  return {
    operation_id: companyOperationId({
      scope: { provider_instance_id: evidence.command.target.provider_instance_id, workspace_id: evidence.command.target.workspace_id },
      request_id: evidence.command.request_id,
      command_digest: controlCommandDigest(evidence.command), operation,
    }),
    evidence_digest: evidence.kind === "jarvis_decision" ? controlValueDigest(evidence.receipt) : evidence.completion.effect_digest,
  };
}

/** Preserve exact original evidence before RPC; a prepared row alone is never proof of a committed decision/effect. */
export function stageCompanyProgressEvidence(authority: AuthorityDb, value: unknown): string {
  const evidence = parseCompanyProgressEvidence(value);
  const expected = identity(evidence);
  const json = canonicalize(evidence);
  authority.db.prepare(
    `INSERT INTO company_progress_evidence_outbox(operation_id,evidence_kind,evidence_json,evidence_digest)
     VALUES(?,?,?,?) ON CONFLICT(operation_id) DO NOTHING`,
  ).run(expected.operation_id, evidence.kind, json, expected.evidence_digest);
  const row = rowSchema.parse(authority.db.prepare(
    "SELECT * FROM company_progress_evidence_outbox WHERE operation_id=?",
  ).get(expected.operation_id));
  if (row.evidence_kind !== evidence.kind || row.evidence_json !== json || row.evidence_digest !== expected.evidence_digest) {
    throw new JarvisError("COMPANY_PROGRESS_UNCERTAIN");
  }
  return expected.operation_id;
}

function assertOriginalDecision(authority: AuthorityDb, command: CompanyCommandV2, receipt: CommandApprovalReceipt, originalAt?: string): void {
  const row = textRow.extend({ created_at: z.string() }).safeParse(authority.db.prepare(
    "SELECT payload_json,created_at FROM control_command_receipts WHERE receipt_id=? AND request_id=?",
  ).get(receipt.receipt_id, command.request_id));
  const key = z.object({ public_key_pem: z.string(), principal_id: z.string() }).safeParse(authority.db.prepare(
    "SELECT public_key_pem,principal_id FROM trusted_authority_keys WHERE key_id=?",
  ).get(receipt.key_id));
  const request = z.object({ command_digest: z.string() }).safeParse(authority.db.prepare(
    "SELECT command_digest FROM control_command_requests WHERE request_id=?",
  ).get(command.request_id));
  if (!row.success || (originalAt !== undefined && row.data.created_at !== originalAt)
    || canonicalize(parseCompanyJson(row.data.payload_json)) !== canonicalize(receipt)
    || !request.success || request.data.command_digest !== controlCommandDigest(command)
    || !key.success || key.data.principal_id !== receipt.signer_principal_id
    || !verifyCommandApproval(receipt, key.data.public_key_pem, new Date(receipt.not_before), command.action)) {
    throw new JarvisError("COMPANY_PROGRESS_UNCERTAIN");
  }
}

/** Read-only historical proof: validate the original commit, not current permission for another mutation. */
export function readCompanyProgressEvidence(authority: AuthorityDb, operationId: string): Evidence {
  const parsed = rowSchema.safeParse(authority.db.prepare(
    "SELECT * FROM company_progress_evidence_outbox WHERE operation_id=?",
  ).get(operationId));
  if (!parsed.success) throw new JarvisError("COMPANY_PROGRESS_UNCERTAIN");
  const row = parsed.data;
  const evidence = parseCompanyProgressEvidence(parseCompanyJson(row.evidence_json));
  const expected = identity(evidence);
  if (expected.operation_id !== operationId || expected.evidence_digest !== row.evidence_digest
    || row.evidence_kind !== evidence.kind) throw new JarvisError("COMPANY_PROGRESS_UNCERTAIN");
  switch (evidence.kind) {
    case "jarvis_decision":
      assertOriginalDecision(authority, evidence.command, evidence.receipt, evidence.original_at);
      break;
    case "jarvis_completion": {
      assertOriginalDecision(authority, evidence.command, evidence.approval);
      const completionRow = z.object({ completion_json: z.string() }).safeParse(authority.db.prepare(
        "SELECT completion_json FROM company_candidate_handoffs WHERE request_id=?",
      ).get(evidence.command.request_id));
      const receiptRow = textRow.safeParse(authority.db.prepare(
        "SELECT payload_json FROM company_candidate_sb_receipts WHERE request_id=? AND operation='accept'",
      ).get(evidence.command.request_id));
      if (!completionRow.success || !receiptRow.success
        || canonicalize(companyCompletionV2Schema.parse(parseCompanyJson(completionRow.data.completion_json))) !== canonicalize(evidence.completion)
        || canonicalize(acceptanceSchema.parse(parseCompanyJson(receiptRow.data.payload_json))) !== canonicalize(evidence.acceptance)) {
        throw new JarvisError("COMPANY_PROGRESS_UNCERTAIN");
      }
      break;
    }
    default: {
      const exhaustive: never = evidence;
      void exhaustive;
      throw new JarvisError("COMPANY_PROGRESS_UNCERTAIN");
    }
  }
  return evidence;
}
