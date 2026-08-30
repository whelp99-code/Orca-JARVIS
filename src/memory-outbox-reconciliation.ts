import type Database from "better-sqlite3";
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

export function latestMemoryOutboxAttempt(
  db: Database.Database,
  outboxId: string,
): Record<string, unknown> {
  const attempt = row(db.prepare(
    "SELECT attempt_id FROM memory_outbox_attempts WHERE outbox_id=? "
    + "ORDER BY created_at DESC,attempt_id DESC LIMIT 1",
  ).get(outboxId));
  if (!attempt) throw new TerminalMemoryError("MEMORY_OUTBOX_ATTEMPT_NOT_FOUND");
  return attempt;
}

export function markMemoryOutboxUncertain(
  db: Database.Database,
  outboxId: string,
  fence: number,
  reason: string,
  now: string,
): Record<string, unknown> {
  const id = identifier(outboxId);
  const at = timestamp(now);
  const current = row(db.prepare(
    "SELECT * FROM memory_outbox WHERE outbox_id=?",
  ).get(id));
  if (!current || current.state !== "accepted_unsettled"
    || Number(current.lease_fence) !== fence || current.lease_owner === null
    || Date.parse(String(current.lease_expires_at)) <= Date.parse(at)) {
    throw new TerminalMemoryError("MEMORY_OUTBOX_RECONCILIATION_REQUIRED");
  }
  const effect = terminalDigest({ id, fence, reason });
  db.prepare(
    `INSERT INTO memory_reconciliation_events
     (event_id,outbox_id,attempt_id,lease_fence,event_type,effect_digest,created_at)
     VALUES(?,?,?,?, 'uncertain',?,?)`,
  ).run(
    `uncertain:${id}:${fence}:${effect}`,
    id,
    String(latestMemoryOutboxAttempt(db, id).attempt_id),
    fence,
    effect,
    at,
  );
  db.prepare(
    "UPDATE memory_outbox SET state='uncertain',lease_owner=NULL,"
    + "lease_expires_at=NULL,updated_at=? WHERE outbox_id=? "
    + "AND state='accepted_unsettled' AND lease_fence=?",
  ).run(at, id, fence);
  const updated = row(db.prepare(
    "SELECT * FROM memory_outbox WHERE outbox_id=?",
  ).get(id));
  if (!updated) throw new TerminalMemoryError("MEMORY_OUTBOX_NOT_FOUND");
  return updated;
}
