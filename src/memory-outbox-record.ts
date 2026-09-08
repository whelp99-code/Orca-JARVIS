import { canonicalize } from "./canonical.js";
import type { MemoryOutboxSagaV2 } from "./memory-outbox-types.js";
import type { ClaimedControlCommand } from "./control-plane.js";
import type { AuthorityDb } from "./db.js";
import { JarvisError } from "./db.js";
import { parseSagaRow, parseMemoryOutboxAction, type MemoryOutboxSpoolRoots } from "./memory-outbox-values.js";
import type { SecondBrainRememberWriteRequest } from "./second-brain-adapter-types.js";

export class MemoryOutboxRecordReader {
  constructor(private readonly authority: AuthorityDb, private readonly roots: MemoryOutboxSpoolRoots = {}) {}
  request(outboxId: string, now: Date): SecondBrainRememberWriteRequest {
    const row = this.authority.db.prepare(
      "SELECT candidate_id,request_id,request_digest,operation,request_profile FROM memory_outbox WHERE outbox_id=?",
    ).get(outboxId) as { candidate_id: string; request_id: string; request_digest: string;
      operation: "remember" | "correct"; request_profile: string } | undefined;
    if (row === undefined) throw new JarvisError("MEMORY_OUTBOX_INTEGRITY_FAILURE");
    if (row.request_profile !== "legacy") throw new JarvisError("MEMORY_OUTBOX_PROFILE_UNSUPPORTED");
    // Content-free outbox rows recover the write request from the claimed control
    // command: spool digest for Task 32, inline request for the shipped Task 30 form.
    const parsed = parseMemoryOutboxAction(this.command(outboxId), now, this.roots).request;
    if (parsed.candidate_id !== row.candidate_id || parsed.request_id !== row.request_id
      || parsed.request_digest !== row.request_digest || parsed.operation !== row.operation) {
      throw new JarvisError("MEMORY_OUTBOX_AUTHORITY_INVALID");
    }
    return parsed;
  }
  attempt(outboxId: string): { attempt_id: string; invocation_digest: string;
    acceptance_receipt_digest: string | null } {
    const row = this.authority.db.prepare(
      "SELECT attempt_id,invocation_digest,acceptance_receipt_digest FROM memory_outbox_attempts WHERE outbox_id=?",
    ).get(outboxId) as { attempt_id: string; invocation_digest: string;
      acceptance_receipt_digest: string | null } | undefined;
    if (row === undefined) throw new JarvisError("MEMORY_OUTBOX_INTEGRITY_FAILURE");
    return row;
  }
  command(outboxId: string): ClaimedControlCommand {
    const row = this.authority.db.prepare(
      `SELECT r.*,x.receipt_id FROM memory_outbox o
       JOIN control_command_requests r ON r.request_id=o.action_request_id
       JOIN control_command_redemptions x ON x.request_id=r.request_id WHERE o.outbox_id=?`,
    ).get(outboxId) as Record<string, unknown> | undefined;
    if (!row) throw new JarvisError("MEMORY_OUTBOX_AUTHORITY_INVALID");
    return { request_id: String(row["request_id"]), receipt_id: String(row["receipt_id"]),
      action: String(row["action"]), action_level: Number(row["action_level"]) as 3,
      target: JSON.parse(String(row["target_json"])) as Record<string, unknown>,
      args: JSON.parse(String(row["args_json"])) as Record<string, unknown>,
      command_digest: String(row["command_digest"]), reversible: Boolean(row["reversible"]),
      fence: Number(row["lease_fence"]), lease_expires_at: String(row["lease_expires_at"]) };
  }
  get(id: string): MemoryOutboxSagaV2 | undefined {
    const row = this.authority.db.prepare("SELECT * FROM memory_outbox WHERE outbox_id=?").get(id);
    return row === undefined ? undefined : parseSagaRow(row);
  }
  list(state: string | undefined, limit: number): readonly MemoryOutboxSagaV2[] {
    const rows = state === undefined
      ? this.authority.db.prepare(
        "SELECT * FROM memory_outbox WHERE request_profile='legacy' AND action_request_id IS NOT NULL ORDER BY created_at,outbox_id LIMIT ?",
      ).all(limit)
      : this.authority.db.prepare(
        `SELECT * FROM memory_outbox WHERE request_profile='legacy' AND action_request_id IS NOT NULL AND state=?
         ORDER BY created_at,outbox_id LIMIT ?`,
      ).all(state, limit);
    return rows.map(parseSagaRow);
  }
  terminalReplay(command: Parameters<typeof parseMemoryOutboxAction>[0]): MemoryOutboxSagaV2 | undefined {
    const row = this.authority.db.prepare(
      `SELECT * FROM memory_outbox WHERE action_request_id=? AND state IN ('settled','conflict','failed','expired')`,
    ).get(command.request_id);
    if (row === undefined) return undefined;
    const saga = parseSagaRow(row);
    const stored = this.command(saga.outbox_id);
    if (command.action !== stored.action || command.action_level !== stored.action_level
      || command.command_digest !== stored.command_digest || command.receipt_id !== stored.receipt_id
      || command.fence !== stored.fence || command.reversible !== stored.reversible
      || canonicalize(command.target) !== canonicalize(stored.target)
      || canonicalize(command.args) !== canonicalize(stored.args)) {
      throw new JarvisError("MEMORY_OUTBOX_REPLAY_CONFLICT");
    }
    // This is a read-back of a committed result, never another authority redemption.
    return saga;
  }

}
