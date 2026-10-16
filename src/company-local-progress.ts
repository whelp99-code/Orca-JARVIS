import { z } from "zod";
import { canonicalize } from "./canonical.js";
import { parseCompanyJson } from "./company-candidate-json.js";
import { companyCheckpointSchema, reserveProgressRequestSchema, type CompanyCheckpoint, type CompanyScope } from "./company-freshness.js";
import { readCompanyProgressEvidence } from "./company-progress-evidence.js";
import { controlValueDigest } from "./control-plane-contract.js";
import type { AuthorityDb } from "./db.js";
import { JarvisError } from "./jarvis-error.js";

const journalSchema = z.object({
  operation_id: z.string(), request_id: z.string(), operation: z.enum(["decide_approve", "decide_reject", "complete"]),
  reserve_request_json: z.string(), checkpoint_json: z.string(), finished_checkpoint_json: z.string().nullable(),
  evidence_digest: z.string().nullable(), terminal_state: z.string().nullable(),
});
const sourceSchema = z.object({ id: z.string() });
const outboxSchema = z.object({ operation_id: z.string(), acknowledged: z.number() });
function rollback(): never { throw new JarvisError("COMPANY_OPERATIONAL_ROLLBACK"); }
function equal(a: unknown, b: unknown): boolean { return canonicalize(a) === canonicalize(b); }

export function companyOtherStorePrefix(previous: CompanyCheckpoint, next: CompanyCheckpoint): boolean {
  const before = previous.stores.second_brain;
  const after = next.stores.second_brain;
  return previous.operational_epoch === next.operational_epoch
    && previous.approval_policy_version === next.approval_policy_version
    && previous.approval_binding_digest === next.approval_binding_digest
    && previous.revocation_sequence === next.revocation_sequence && previous.revocation_root === next.revocation_root
    && equal(previous.stores.jarvis, next.stores.jarvis)
    && next.intent_sequence > previous.intent_sequence && next.intent_root !== previous.intent_root
    && !equal(before, after)
    && (["receipt", "terminal", "deletion"] as const).every(stream => {
      const a = before[`${stream}_sequence`]; const b = after[`${stream}_sequence`];
      return a === b ? before[`${stream}_root`] === after[`${stream}_root`]
        : b > a && before[`${stream}_root`] !== after[`${stream}_root`];
    });
}

/**
 * Rebuild own fact coverage from committed originals and their authenticated finish journal.
 * SB mirrors never enter these sets. Retained ack roots cannot stand in for a lost original.
 */
export function assertCompanyLocalProgress(authority: AuthorityDb, scope: CompanyScope, checkpoint: CompanyCheckpoint): void {
  const entries = z.array(journalSchema).parse(authority.db.prepare(
    `SELECT operation_id,request_id,operation,reserve_request_json,checkpoint_json,finished_checkpoint_json,evidence_digest,terminal_state
     FROM company_progress_reservations WHERE provider_instance_id=? AND workspace_id=?
     AND operation IN ('decide_approve','decide_reject','complete')`,
  ).all(scope.provider_instance_id, scope.workspace_id)).map(row => ({
    row, request: reserveProgressRequestSchema.parse(parseCompanyJson(row.reserve_request_json)),
    reserved: companyCheckpointSchema.parse(parseCompanyJson(row.checkpoint_json)),
    finished: row.finished_checkpoint_json === null ? null : companyCheckpointSchema.parse(parseCompanyJson(row.finished_checkpoint_json)),
  })).sort((a, b) => a.request.expected_checkpoint.intent_sequence - b.request.expected_checkpoint.intent_sequence);
  if (entries.some((entry, index) => entry.finished === null && index !== entries.length - 1)) rollback();
  const receipts = new Set<string>();
  const completions = new Set<string>();
  let own = entries[0]?.request.expected_checkpoint.stores.jarvis ?? checkpoint.stores.jarvis;
  if (own.receipt_sequence !== 0 || own.terminal_sequence !== 0 || own.deletion_sequence !== 0) rollback();
  let lastIntent = -1;
  for (const { row, request, reserved, finished } of entries) {
    const previous = request.expected_checkpoint;
    if (!equal(request.scope, scope) || request.operation_id !== row.operation_id || request.operation !== row.operation
      || previous.intent_sequence < lastIntent || !equal(previous.stores.jarvis, own)
      || reserved.intent_sequence !== previous.intent_sequence + 1 || reserved.intent_root === previous.intent_root
      || !equal(previous.stores, reserved.stores)) rollback();
    for (const value of [previous, reserved, ...(finished ? [finished] : [])]) {
      if (value.operational_epoch !== checkpoint.operational_epoch
        || value.approval_policy_version !== checkpoint.approval_policy_version
        || value.approval_binding_digest !== checkpoint.approval_binding_digest
        || value.revocation_sequence !== checkpoint.revocation_sequence || value.revocation_root !== checkpoint.revocation_root) rollback();
    }
    lastIntent = reserved.intent_sequence;
    if (finished === null) {
      if (row.evidence_digest !== null || row.terminal_state !== null) rollback();
      continue;
    }
    const evidence = readCompanyProgressEvidence(authority, row.operation_id);
    const operation = evidence.kind === "jarvis_completion" ? "complete"
      : evidence.receipt.decision === "approve" ? "decide_approve" : "decide_reject";
    const evidenceDigest = evidence.kind === "jarvis_completion" ? evidence.completion.effect_digest : controlValueDigest(evidence.receipt);
    const eventDigest = evidence.kind === "jarvis_completion" ? evidence.acceptance.receipt_digest : evidenceDigest;
    const terminal = operation === "complete" ? "completed" : operation === "decide_approve" ? "approved" : "rejected";
    const next = finished.stores.jarvis;
    const terminalDelta = operation === "decide_approve" ? 0 : 1;
    if (evidence.command.request_id !== row.request_id || operation !== row.operation
      || row.evidence_digest !== evidenceDigest || request.event_digest !== eventDigest || row.terminal_state !== terminal
      || finished.intent_sequence !== reserved.intent_sequence + 1 || finished.intent_root === reserved.intent_root
      || !equal(reserved.stores.second_brain, finished.stores.second_brain)
      || next.receipt_sequence !== own.receipt_sequence + 1 || next.receipt_root === own.receipt_root
      || next.terminal_sequence !== own.terminal_sequence + terminalDelta
      || (terminalDelta === 0 ? next.terminal_root !== own.terminal_root : next.terminal_root === own.terminal_root)
      || next.deletion_sequence !== own.deletion_sequence || next.deletion_root !== own.deletion_root) rollback();
    if (evidence.kind === "jarvis_decision") receipts.add(evidence.receipt.receipt_id);
    else completions.add(evidence.command.request_id);
    own = next;
    lastIntent = finished.intent_sequence;
  }
  if (!equal(own, checkpoint.stores.jarvis)) rollback();
  const scopeArgs = [scope.provider_instance_id, scope.workspace_id];
  const actualReceipts = z.array(sourceSchema).parse(authority.db.prepare(
    `SELECT a.receipt_id AS id FROM control_command_receipts a JOIN control_command_requests r ON r.request_id=a.request_id
     WHERE r.action='company.candidate.transition' AND r.schema_version=2
     AND json_extract(r.target_json,'$.provider_instance_id')=? AND json_extract(r.target_json,'$.workspace_id')=?`,
  ).all(...scopeArgs));
  const actualCompletions = z.array(sourceSchema).parse(authority.db.prepare(
    `SELECT h.request_id AS id FROM company_candidate_handoffs h JOIN control_command_requests r ON r.request_id=h.request_id
     WHERE r.action='company.candidate.transition' AND r.schema_version=2 AND h.completion_json IS NOT NULL
     AND json_extract(r.target_json,'$.provider_instance_id')=? AND json_extract(r.target_json,'$.workspace_id')=?`,
  ).all(...scopeArgs));
  if (actualReceipts.length !== receipts.size || actualReceipts.some(row => !receipts.has(row.id))
    || actualCompletions.length !== completions.size || actualCompletions.some(row => !completions.has(row.id))) rollback();
  const outbox = z.array(outboxSchema).parse(authority.db.prepare(
    `SELECT operation_id,acknowledged FROM company_progress_evidence_outbox
     WHERE json_extract(evidence_json,'$.command.target.provider_instance_id')=?
     AND json_extract(evidence_json,'$.command.target.workspace_id')=?`,
  ).all(...scopeArgs));
  for (const proof of outbox) {
    const journal = entries.find(entry => entry.row.operation_id === proof.operation_id);
    if (!journal || proof.acknowledged !== (journal.finished === null ? 0 : 1)) rollback();
    readCompanyProgressEvidence(authority, proof.operation_id);
  }
}
