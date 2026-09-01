import { createHash } from "node:crypto";
import { canonicalize } from "./canonical.js";
import type { CommandApprovalReceipt } from "./control-plane-contract.js";
import type { AuthorityDb } from "./db.js";

const hash = (domain: string, value: unknown): string => `sha256:${createHash("sha256")
  .update(domain).update(canonicalize(value)).digest("hex")}`;
export class MemorySurfaceAuthority {
  constructor(private readonly authority: AuthorityDb) {}
  applyReceipt(receipt: CommandApprovalReceipt, requestId: string, now: Date): void {
    const available = this.authority.db.prepare(
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name='memory_surface_effect_attempts'",
    ).get();
    if (available === undefined) return;
    const attempt = this.authority.db.prepare(
      `SELECT a.attempt_id,a.state,f.operation,f.target_version_digest
       FROM memory_surface_effect_attempts a JOIN memory_surface_semantic_families f
       ON f.family_digest=a.family_digest WHERE a.control_request_id=?`,
    ).get(requestId) as { readonly attempt_id: string; readonly state: string;
      readonly operation: "correct" | "forget" | "export"; readonly target_version_digest: string } | undefined;
    if (attempt === undefined || attempt.state !== "staged") return;
    if (receipt.decision === "reject") {
      this.authority.db.prepare(
        "UPDATE memory_surface_effect_attempts SET state='receipt_rejected',updated_at=? WHERE attempt_id=? AND state='staged'",
      ).run(now.toISOString(), attempt.attempt_id); return;
    }
    this.authority.db.prepare(
      "UPDATE memory_surface_effect_attempts SET state='approved',updated_at=? WHERE attempt_id=? AND state='staged'",
    ).run(now.toISOString(), attempt.attempt_id);
    if (attempt.operation === "export") return;
    const target = this.authority.db.prepare(
      "SELECT membership_digest FROM memory_surface_target_versions WHERE target_version_digest=?",
    ).get(attempt.target_version_digest) as { readonly membership_digest: string };
    const current = this.authority.db.prepare(
      "SELECT privacy_epoch,suppression_sequence,suppression_root FROM memory_surface_authority WHERE singleton_id=1",
    ).get() as { readonly privacy_epoch: number; readonly suppression_sequence: number;
      readonly suppression_root: string };
    const sequence = current.suppression_sequence + 1;
    const root = hash("orca-jarvis/memory-surface-suppression/v1\0", { sequence,
      previous_root: current.suppression_root, target_version_digest: attempt.target_version_digest,
      membership_digest: target.membership_digest, operation: attempt.operation,
      command_digest: receipt.command_digest, receipt_id: receipt.receipt_id,
      effective_at: now.toISOString() });
    this.authority.db.prepare(
      `INSERT INTO memory_surface_suppressions(sequence,suppression_root,previous_root,
       target_version_digest,membership_digest,operation,control_request_id,control_receipt_id,
       command_digest,effective_at) VALUES(?,?,?,?,?,?,?,?,?,?)`,
    ).run(sequence, root, current.suppression_root, attempt.target_version_digest,
      target.membership_digest, attempt.operation, requestId, receipt.receipt_id,
      receipt.command_digest, now.toISOString());
    const epoch = current.privacy_epoch + 1;
    this.authority.db.prepare(
      `UPDATE memory_surface_authority SET privacy_epoch=?,suppression_sequence=?,suppression_root=?,
       updated_at=? WHERE singleton_id=1 AND privacy_epoch=?`,
    ).run(epoch, sequence, root, now.toISOString(), current.privacy_epoch);
    this.authority.db.prepare(
      `INSERT INTO memory_privacy_epoch_events(privacy_epoch,event_kind,resource_revision,occurred_at)
       VALUES(?,'suppression',?,?)`,
    ).run(epoch, hash("orca-jarvis/memory-privacy-event/v1\0", { epoch, sequence, root }), now.toISOString());
  }
}
