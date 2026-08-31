import type { AuthorityDb } from "./db.js";
import type { MemoryObservation } from "./memory-outbox-types.js";
import { memoryOutboxHash } from "./memory-outbox-values.js";

export class MemoryOutboxLedger {
  constructor(private readonly authority: AuthorityDb) {}
  attemptId(id: string): string | undefined {
    return (this.authority.db.prepare(
      "SELECT attempt_id FROM memory_outbox_attempts WHERE outbox_id=? AND attempt_id LIKE 'memattempt:pos:v2:%'",
    ).get(id) as { attempt_id?: string } | undefined)?.attempt_id;
  }
  event(outboxId: string, fence: number, type: string, code: string | null, at: string,
    attemptId?: string, receipt?: string, observation?: MemoryObservation): string {
    const digest = memoryOutboxHash("memory-outbox-observation", {
      outbox_id: outboxId, attempt_id: attemptId ?? null, reconcile_fence: fence, event_type: type,
      outcome_code: code, page_id: observation?.page_id ?? null, sid: observation?.sid ?? null,
      source_version: observation?.source_version ?? null,
      source_digest: observation?.source_digest ?? receipt ?? null, observed_at: at,
    });
    this.authority.db.prepare(
      `INSERT OR IGNORE INTO memory_reconciliation_events(
        event_id,outbox_id,attempt_id,lease_fence,event_type,outcome_code,page_id,sid,source_version,
        observed_artifact_digest,effect_digest,created_at
       ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(`event:memory-outbox:v2:${digest.slice(7)}`, outboxId, attemptId ?? null, fence, type, code,
      observation?.page_id ?? null, observation?.sid ?? null, observation?.source_version ?? null,
      observation?.source_digest ?? null, digest, at);
    return digest;
  }
  audit(id: string, event: string, prior: string | null, next: string, fence: number,
    cause: string, receipt: string | null, at: string): void {
    const row = this.authority.db.prepare(
      `SELECT c.correlation_id,m.owner_principal FROM memory_outbox o
       JOIN memory_candidates c ON c.candidate_id=o.candidate_id
       JOIN memory_candidate_classifications m ON m.candidate_id=c.candidate_id WHERE o.outbox_id=?`,
    ).get(id) as { correlation_id: string; owner_principal: string };
    const digest = memoryOutboxHash("memory-outbox-audit", {
      outbox_id: id, event_type: event, prior_state: prior, next_state: next,
      lease_fence: fence, causation_id: cause, receipt_digest: receipt, created_at: at,
    });
    this.authority.db.prepare(
      `INSERT OR IGNORE INTO personal_operation_audit_events(
        event_id,event_type,subject_kind,subject_id,principal_id,correlation_id,causation_id,event_digest,created_at
       ) VALUES(?,?,?,?,?,?,?,?,?)`,
    ).run(`event:memory-outbox:v2:${digest.slice(7)}`, `memory.outbox.${event}`, "memory_outbox", id,
      row.owner_principal, row.correlation_id, cause, digest, at);
  }
}
