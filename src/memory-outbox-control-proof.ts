import { canonicalize } from "./canonical.js";
import { controlCommandDigest, verifyCommandApproval, type CommandApprovalReceipt, type StoredControlCommand } from "./control-plane-contract.js";
import { validateControlAction } from "./control-actions.js";
import { JarvisError, type AuthorityDb } from "./db.js";
import { memoryInvocation, memoryObservationDigest, memoryOutboxHash, memoryOutboxSettlementReceipt, parseSagaRow } from "./memory-outbox-values.js";

const invalid = (): never => { throw new JarvisError("MEMORY_OUTBOX_CONTROL_EVIDENCE_INVALID"); };
type Event = { event_id: string; outbox_id: string; attempt_id: string | null; reconcile_fence: number;
  event_type: string; outcome_code: string | null; page_id: string | null; sid: string | null;
  source_version: string | null; observed_artifact_digest: string | null; effect_digest: string; created_at: string };
type Attempt = { attempt_id: string; dispatch_fence: number; invocation_digest: string;
  request_digest: string; acceptance_receipt_digest: string | null; dispatched_at: string };

/** Reconstruct a terminal observation from durable, content-free ledgers. This
 * validates already-spent authority at its original time; it grants no new write. */
export function memoryOutboxControlProof(authority: AuthorityDb, outboxId: string,
  command: StoredControlCommand, fence: number) {
  try { return proof(authority, outboxId, command, fence); }
  catch { return invalid(); }
}

function proof(authority: AuthorityDb, outboxId: string, command: StoredControlCommand, fence: number) {
  const row = authority.db.prepare("SELECT * FROM memory_outbox WHERE outbox_id=?").get(outboxId) as Record<string, unknown> | undefined;
  if (row === undefined) return invalid();
  const saga = parseSagaRow(row);
  if (!["settled", "conflict", "failed", "expired"].includes(saga.state)
    || command.action !== "memory.outbox.dispatch" || ![1, 2].includes(Number(command.args.schema_version))
    || command.command_digest !== controlCommandDigest(command) || row.action_request_id !== command.request_id
    || row.action_command_digest !== command.command_digest || command.reversible
    || command.target.candidate_id !== saga.candidate_id || command.target.candidate_digest !== saga.candidate_digest
    || command.target.classification_digest !== saga.classification_digest
    || canonicalize(command.args.expected_artifact) !== canonicalize(saga.expected_artifact)) return invalid();
  validateControlAction(command, { enforceMinimumLevel: true, levelErrorCode: "MEMORY_OUTBOX_CONTROL_EVIDENCE_INVALID" });
  const identity = memoryOutboxHash("memory-outbox", { candidate_id: saga.candidate_id,
    candidate_digest: saga.candidate_digest, classification_digest: saga.classification_digest,
    request_id: saga.request_id, request_digest: saga.request_digest, idempotency_key: row.idempotency_key,
    operation: saga.operation, expected_artifact: saga.expected_artifact });
  if (outboxId !== `memout:pos:v2:${identity.slice(7)}`) return invalid();
  const binding = authority.db.prepare(
    `SELECT x.receipt_id,x.redeemed_at,a.payload_json,a.signature,k.public_key_pem,k.principal_id
     FROM control_command_redemptions x JOIN control_command_receipts a ON a.receipt_id=x.receipt_id
     JOIN trusted_authority_keys k ON k.key_id=a.key_id
     JOIN authority_key_purposes p ON p.key_id=k.key_id AND p.purpose='decision'
     WHERE x.request_id=? AND x.lease_fence=? AND a.request_id=x.request_id`,
  ).get(command.request_id, fence) as { receipt_id: string; redeemed_at: string; payload_json: string;
    signature: string; public_key_pem: string; principal_id: string } | undefined;
  if (binding === undefined || binding.receipt_id !== row.action_receipt_id) return invalid();
  const receipt = JSON.parse(binding.payload_json) as CommandApprovalReceipt;
  const redeemed = new Date(binding.redeemed_at);
  if (!Number.isFinite(redeemed.getTime()) || receipt.decision !== "approve"
    || receipt.request_id !== command.request_id || receipt.receipt_id !== binding.receipt_id
    || receipt.command_digest !== command.command_digest || receipt.signature !== binding.signature
    || receipt.signer_principal_id !== binding.principal_id
    || !verifyCommandApproval(receipt, binding.public_key_pem, redeemed)
    || Date.parse(command.expires_at) <= redeemed.getTime() || Date.parse(saga.created_at) < redeemed.getTime()) return invalid();
  const attempt = authority.db.prepare("SELECT * FROM memory_outbox_attempts WHERE outbox_id=?")
    .get(outboxId) as Attempt | undefined;
  const event = (type: string): Event => {
    const found = authority.db.prepare("SELECT * FROM memory_reconciliation_events WHERE outbox_id=? AND event_type=?")
      .get(outboxId, type) as Event | undefined;
    if (found === undefined) return invalid();
    return found;
  };
  let terminal: Event;
  if (saga.state === "settled" || saga.state === "conflict") {
    if (attempt === undefined || saga.dispatch_fence === null || attempt.dispatch_fence !== saga.dispatch_fence
      || attempt.request_digest !== saga.request_digest || attempt.dispatched_at !== saga.dispatched_at
      || !Number.isFinite(Date.parse(attempt.dispatched_at)) || Date.parse(attempt.dispatched_at) < redeemed.getTime()
      || !verifyCommandApproval(receipt, binding.public_key_pem, new Date(attempt.dispatched_at))
      || Date.parse(command.expires_at) <= Date.parse(attempt.dispatched_at)) return invalid();
    const invocation = memoryInvocation(outboxId, saga.request_digest, saga.dispatch_fence);
    if (attempt.attempt_id !== invocation.attempt_id || attempt.invocation_digest !== invocation.digest) return invalid();
    const spent = event("dispatch_authority_spent");
    checkEvent(spent, null);
    if (spent.attempt_id !== attempt.attempt_id || spent.reconcile_fence !== saga.dispatch_fence
      || spent.created_at !== attempt.dispatched_at || spent.outcome_code !== null) return invalid();
    terminal = event(saga.state === "settled" ? "artifact_observed" : "artifact_conflict");
    checkObservation(terminal);
    if (terminal.attempt_id !== attempt.attempt_id || terminal.reconcile_fence !== saga.lease_fence
      || Date.parse(terminal.created_at) < Date.parse(attempt.dispatched_at)) return invalid();
    if (saga.state === "settled") {
      if (terminal.page_id !== saga.expected_artifact.page_id || terminal.sid !== saga.expected_artifact.sid
        || terminal.observed_artifact_digest !== saga.expected_artifact.source_digest || terminal.source_version === null
        || terminal.created_at !== saga.settled_at || terminal.outcome_code !== "ARTIFACT_OBSERVED") return invalid();
      const computed = memoryOutboxSettlementReceipt({ saga, attempt,
        observation: { kind: "match", code: terminal.outcome_code, page_id: terminal.page_id,
          sid: terminal.sid, source_version: terminal.source_version, source_digest: terminal.observed_artifact_digest },
        settled: { observationDigest: terminal.effect_digest, at: terminal.created_at } });
      const settled = event("settled"); checkEvent(settled, computed);
      if (computed !== saga.settlement_receipt_digest || settled.effect_digest !== computed
        || settled.attempt_id !== attempt.attempt_id || settled.reconcile_fence !== terminal.reconcile_fence
        || settled.created_at !== terminal.created_at || settled.outcome_code !== terminal.outcome_code
        || settled.page_id !== terminal.page_id || settled.sid !== terminal.sid
        || settled.source_version !== terminal.source_version || settled.observed_artifact_digest !== terminal.observed_artifact_digest) return invalid();
    } else if (saga.failure_code !== terminal.outcome_code || saga.settlement_receipt_digest !== null
      || saga.updated_at !== terminal.created_at) return invalid();
  } else {
    terminal = event(saga.state); checkEvent(terminal, null);
    const expected = saga.state === "expired" ? "MEMORY_OUTBOX_EXPIRED" : "MEMORY_OUTBOX_AUTHORITY_INVALID";
    if (attempt !== undefined || saga.dispatch_fence !== null || terminal.attempt_id !== null
      || terminal.outcome_code !== expected || saga.failure_code !== expected
      || terminal.created_at !== saga.updated_at || saga.settlement_receipt_digest !== null) return invalid();
  }
  if (!Number.isFinite(Date.parse(terminal.created_at)) || !Number.isFinite(Date.parse(saga.created_at))
    || Date.parse(terminal.created_at) < Date.parse(saga.created_at)) return invalid();
  return { receipt_id: binding.receipt_id, observed_at: terminal.created_at,
    outcome: saga.state === "settled" ? "completed" as const : "failed" as const,
    failure_code: saga.state === "settled" ? null : saga.failure_code,
    payload: { outbox_id: outboxId, state: saga.state, request_digest: saga.request_digest,
      settlement_receipt_digest: saga.settlement_receipt_digest, terminal_event_id: terminal.event_id,
      terminal_evidence_digest: terminal.effect_digest } };
}

function checkEvent(event: Event, receipt: string | null): void {
  const digest = memoryOutboxHash("memory-outbox-event", { outbox_id: event.outbox_id,
    attempt_id: event.attempt_id, reconcile_fence: event.reconcile_fence, event_type: event.event_type,
    outcome_code: event.outcome_code, receipt_digest: receipt, created_at: event.created_at });
  if (event.event_id !== `event:memory-outbox:v2:${digest.slice(7)}`
    || event.effect_digest !== (receipt ?? digest)) invalid();
}
function checkObservation(event: Event): void {
  if (event.attempt_id === null) return invalid();
  const digest = memoryObservationDigest({ outbox_id: event.outbox_id, attempt_id: event.attempt_id,
    reconcile_fence: event.reconcile_fence, page_id: event.page_id, sid: event.sid,
    source_version: event.source_version, source_digest: event.observed_artifact_digest,
    observed_at: event.created_at, outcome: event.outcome_code ?? event.event_type });
  if (event.effect_digest !== digest || event.event_id !== `event:memory-outbox:v2:${digest.slice(7)}`) invalid();
}
