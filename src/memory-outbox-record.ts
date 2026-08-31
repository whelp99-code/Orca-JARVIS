import type { ClaimedControlCommand } from "./control-plane.js";
import type { AuthorityDb } from "./db.js";
import { JarvisError } from "./db.js";
import type { SecondBrainWriteRequestV1 } from "./second-brain-adapter-types.js";
import { parseSecondBrainWriteRequest } from "./second-brain-write-request.js";

export class MemoryOutboxRecordReader {
  constructor(private readonly authority: AuthorityDb) {}
  request(outboxId: string, now: Date): SecondBrainWriteRequestV1 {
    const row = this.authority.db.prepare(
      "SELECT request_json FROM memory_outbox WHERE outbox_id=?",
    ).get(outboxId) as { request_json?: string } | undefined;
    let value: unknown;
    try { value = JSON.parse(row?.request_json ?? "null"); }
    catch { throw new JarvisError("MEMORY_OUTBOX_INTEGRITY_FAILURE"); }
    const parsed = parseSecondBrainWriteRequest(value, now);
    if (parsed === undefined) throw new JarvisError("MEMORY_OUTBOX_AUTHORITY_INVALID");
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
}
