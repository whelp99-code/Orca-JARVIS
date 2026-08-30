import type Database from "better-sqlite3";
import {
  expectedArtifactDigest,
  expectedArtifactSelector,
  type MemoryOutboxQueueInput,
} from "./memory-outbox-contract.js";
import {
  TerminalMemoryError,
  identifier,
  terminalDigest,
  timestamp,
} from "./terminal-memory-validation.js";

function row(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? value as Record<string, unknown>
    : undefined;
}

export function queueMemoryOutbox(
  db: Database.Database,
  input: MemoryOutboxQueueInput,
): Record<string, unknown> {
  const now = timestamp(input.now);
  const expires = timestamp(input.expires_at);
  const candidateId = identifier(input.candidate_id);
  const expectedDigest = expectedArtifactDigest(input.expected_artifact_digest);
  const expectedSelector = expectedArtifactSelector(input.expected_artifact_selector);
  if (Date.parse(expires) <= Date.parse(now)) {
    throw new TerminalMemoryError("MEMORY_OUTBOX_EXPIRED");
  }
  const candidate = row(db.prepare(
    "SELECT candidate_id,state,operation,required_confirmation,content_digest,"
    + "source_digest,expires_at FROM memory_candidates WHERE candidate_id=?",
  ).get(candidateId));
  if (!candidate) throw new TerminalMemoryError("MEMORY_CANDIDATE_NOT_FOUND");
  const classified = String(candidate.state) === "classified";
  if (!(["approved", "classified"].includes(String(candidate.state)))
    || (classified && Number(candidate.required_confirmation) !== 0)) {
    throw new TerminalMemoryError("MEMORY_CANDIDATE_NOT_APPROVED");
  }
  if (String(candidate.operation) !== input.operation) {
    throw new TerminalMemoryError("MEMORY_OPERATION_CONFLICT");
  }
  const requestDigest = terminalDigest({
    candidate_id: candidateId,
    operation: input.operation,
    expected_artifact_selector: expectedSelector,
    expected_artifact_digest: expectedDigest,
    provider_version: input.provider_version,
  });
  const existing = row(db.prepare(
    "SELECT * FROM memory_outbox WHERE idempotency_key=?",
  ).get(input.idempotency_key));
  if (existing) {
    if (String(existing.request_digest) !== requestDigest) {
      throw new TerminalMemoryError("MEMORY_OUTBOX_REPLAY_CONFLICT");
    }
    return existing;
  }
  if (classified) {
    db.prepare(
      "UPDATE memory_candidates SET state='approved',updated_at=? "
      + "WHERE candidate_id=? AND state='classified'",
    ).run(now, candidateId);
  }
  db.prepare(
    `INSERT INTO memory_outbox
     (outbox_id,candidate_id,idempotency_key,operation,request_digest,
      expected_artifact_selector,expected_artifact_digest,provider_version,
      state,expires_at,created_at,updated_at)
     VALUES(?,?,?,?,?,?,?,?, 'queued',?,?,?)`,
  ).run(
    identifier(input.outbox_id),
    candidateId,
    identifier(input.idempotency_key),
    input.operation,
    requestDigest,
    expectedSelector,
    expectedDigest,
    input.provider_version,
    expires,
    now,
    now,
  );
  const created = row(db.prepare(
    "SELECT * FROM memory_outbox WHERE outbox_id=?",
  ).get(input.outbox_id));
  if (!created) throw new TerminalMemoryError("MEMORY_OUTBOX_NOT_FOUND");
  return created;
}

export function claimMemoryOutbox(
  db: Database.Database,
  outboxId: string,
  owner: string,
  now: string,
  leaseMs = 30_000,
): Record<string, unknown> {
  const id = identifier(outboxId);
  const worker = identifier(owner);
  const at = timestamp(now);
  if (!Number.isSafeInteger(leaseMs) || leaseMs < 1 || leaseMs > 15 * 60_000) {
    throw new TerminalMemoryError("MEMORY_OUTBOX_CLAIM_INVALID");
  }
  const current = row(db.prepare(
    "SELECT * FROM memory_outbox WHERE outbox_id=?",
  ).get(id));
  if (!current) throw new TerminalMemoryError("MEMORY_OUTBOX_NOT_FOUND");
  const state = String(current.state);
  const expiredLease = current.lease_expires_at !== null
    && Date.parse(String(current.lease_expires_at)) <= Date.parse(at);
  const reclaimable = ["delivering", "accepted_unsettled"].includes(state)
    && expiredLease;
  if (state !== "queued" && !reclaimable) {
    throw new TerminalMemoryError("MEMORY_OUTBOX_NOT_CLAIMABLE");
  }
  const expires = Date.parse(String(current.expires_at));
  const lease = new Date(Math.min(Date.parse(at) + leaseMs, expires)).toISOString();
  if (Date.parse(lease) <= Date.parse(at)) {
    throw new TerminalMemoryError("MEMORY_OUTBOX_EXPIRED");
  }
  const fence = Number(current.lease_fence) + 1;
  const nextState = state === "queued" ? "delivering" : state;
  const changed = db.prepare(
    `UPDATE memory_outbox
     SET state=?,lease_owner=?,lease_fence=?,lease_expires_at=?,updated_at=?
     WHERE outbox_id=? AND lease_fence=? AND (
       state='queued' OR (
         state IN ('delivering','accepted_unsettled') AND lease_expires_at<=?
       )
     )`,
  ).run(nextState, worker, fence, lease, at, id, current.lease_fence, at);
  if (changed.changes !== 1) {
    throw new TerminalMemoryError("MEMORY_OUTBOX_CLAIM_CONFLICT");
  }
  const claimed = row(db.prepare(
    "SELECT * FROM memory_outbox WHERE outbox_id=?",
  ).get(id));
  if (!claimed) throw new TerminalMemoryError("MEMORY_OUTBOX_NOT_FOUND");
  return claimed;
}
