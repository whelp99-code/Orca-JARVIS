import { createHash } from "node:crypto";
import { canonicalize } from "./canonical.js";
import type { CommandApprovalReceipt } from "./control-plane-contract.js";
import type { AuthorityDb } from "./db.js";
import {
  MemoryCandidateDispatchSpool,
  type MemoryCandidateDispatchPublication,
} from "./memory-candidate-dispatch-spool.js";
import { MemoryCandidateReviewSpool } from "./memory-candidate-review-spool.js";

const hash = (domain: string, value: unknown): string => `sha256:${createHash("sha256")
  .update(domain).update(canonicalize(value)).digest("hex")}`;
type CandidateSpoolRoots = { readonly review_root?: string; readonly dispatch_root?: string };
const candidateSpoolRoots = new WeakMap<AuthorityDb, CandidateSpoolRoots>();

export function registerMemoryCandidateSpoolRoots(authority: AuthorityDb, roots: CandidateSpoolRoots): void {
  candidateSpoolRoots.set(authority, roots);
}

export class MemorySurfaceAuthority {
  constructor(private readonly authority: AuthorityDb) {}
  applyReceipt(receipt: CommandApprovalReceipt, requestId: string, now: Date): void {
    if (this.applyCandidateReceipt(receipt, requestId, now)) return;
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

  private applyCandidateReceipt(receipt: CommandApprovalReceipt, requestId: string, now: Date): boolean {
    const attempt = this.authority.db.prepare(
      `SELECT a.attempt_id,a.state,a.target_version_digest,a.expected_prior_digest,
          a.target_manifest_digest,a.scope_digest,a.expected_prior_json,f.candidate_id,f.decision,f.content_digest,
          m.candidate_digest,m.classification_digest,c.operation,c.confirmation_expires_at,c.expires_at
       FROM memory_candidate_decision_attempts a
       JOIN memory_candidate_decision_families f ON f.family_digest=a.family_digest
       JOIN memory_candidates c ON c.candidate_id=f.candidate_id
       JOIN memory_candidate_classifications m ON m.candidate_id=c.candidate_id
       WHERE a.control_request_id=?`,
    ).get(requestId) as {
      readonly attempt_id: string; readonly state: string; readonly target_version_digest: string | null;
      readonly expected_prior_digest: string | null; readonly target_manifest_digest: string | null;
      readonly scope_digest: string | null; readonly expected_prior_json: string | null;
      readonly candidate_id: string; readonly decision: "confirm" | "reject";
      readonly content_digest: string; readonly candidate_digest: string; readonly classification_digest: string;
      readonly operation: "remember" | "correct"; readonly confirmation_expires_at: string | null;
      readonly expires_at: string;
    } | undefined;
    if (attempt === undefined) return false;
    if (attempt.state !== "staged") return true;
    if (receipt.decision === "reject") {
      this.authority.db.prepare(
        "UPDATE memory_candidate_decision_attempts SET state='receipt_rejected',updated_at=? WHERE attempt_id=? AND state='staged'",
      ).run(now.toISOString(), attempt.attempt_id);
      return true;
    }
    const roots = candidateSpoolRoots.get(this.authority);
    const reviewRoot = roots?.review_root ?? process.env.JARVIS_MEMORY_REVIEW_SPOOL_ROOT;
    const dispatchRoot = roots?.dispatch_root ?? process.env.JARVIS_MEMORY_DISPATCH_SPOOL_ROOT;
    if (reviewRoot === undefined || dispatchRoot === undefined) throw new Error("MEMORY_REVIEW_UNAVAILABLE");
    const review = new MemoryCandidateReviewSpool(reviewRoot).read(attempt.candidate_id);
    if (review.candidate_digest !== attempt.candidate_digest
      || review.classification_digest !== attempt.classification_digest
      || review.content_digest !== attempt.content_digest
      || review.operation !== attempt.operation) throw new Error("MEMORY_REVIEW_INTEGRITY_FAILURE");
    const receiptDigest = hash("orca-jarvis/memory-confirmation-receipt/v1\0", receipt);
    let dispatch: MemoryCandidateDispatchPublication | undefined;
    try {
      const decisionId = `memdecision:pos:v1:${hash("orca-jarvis/memory-candidate-decision/v1\0", {
        candidate_id: attempt.candidate_id, attempt_id: attempt.attempt_id,
        receipt_id: receipt.receipt_id, command_digest: receipt.command_digest,
      }).slice(7)}`;
      this.authority.db.prepare(
        `INSERT INTO memory_candidate_owner_decisions(
          decision_id,candidate_id,attempt_id,decision,control_request_id,control_receipt_id,
          command_digest,decided_at
        ) VALUES(?,?,?,?,?,?,?,?)`,
      ).run(decisionId, attempt.candidate_id, attempt.attempt_id, attempt.decision, requestId,
        receipt.receipt_id, receipt.command_digest, now.toISOString());
      if (attempt.decision === "reject") {
        this.authority.db.prepare(
          "UPDATE memory_candidates SET state='rejected',updated_at=? WHERE candidate_id=? AND state='awaiting_confirmation'",
        ).run(now.toISOString(), attempt.candidate_id);
      } else {
        const target = attempt.operation === "correct"
          ? {
            target_version_digest: requiredText(attempt.target_version_digest),
            expected_prior_digest: requiredText(attempt.expected_prior_digest),
            target_manifest_digest: requiredText(attempt.target_manifest_digest),
            scope_digest: requiredText(attempt.scope_digest),
            expected_prior: parseExpectedPrior(attempt.expected_prior_json),
          } : undefined;
        dispatch = new MemoryCandidateDispatchSpool(dispatchRoot).publish(review, {
          control_request_id: requestId, control_receipt_id: receipt.receipt_id,
          command_digest: receipt.command_digest, issued_at: receipt.issued_at,
          principal_id: "principal:owner",
          expires_at: attempt.confirmation_expires_at ?? attempt.expires_at,
        }, target);
        this.authority.db.prepare(
          `INSERT INTO memory_candidate_dispatch_publications(
            candidate_id,schema_version,operation,dispatch_spool_digest,target_version_digest,
            expected_prior_digest,scope_digest,state,published_at
          ) VALUES(?,?,?,?,?,?,?,'published',?)`,
        ).run(attempt.candidate_id, dispatch.schema_version, dispatch.operation,
          dispatch.dispatch_spool_digest, target?.target_version_digest ?? null,
          target?.expected_prior_digest ?? null, target?.scope_digest ?? null, now.toISOString());
        this.authority.db.prepare(
          `UPDATE memory_candidates SET state='approved',confirmation_principal_id=?,
             confirmation_request_id=?,confirmation_receipt_id=?,confirmation_receipt_digest=?,
             confirmation_evidence_digest=?,updated_at=? WHERE candidate_id=? AND state='awaiting_confirmation'`,
        ).run("principal:owner", requestId, receipt.receipt_id, receiptDigest,
          review.review_envelope_digest, now.toISOString(), attempt.candidate_id);
      }
      this.authority.db.prepare(
        "UPDATE memory_candidate_decision_attempts SET state='applied',updated_at=? WHERE attempt_id=? AND state='staged'",
      ).run(now.toISOString(), attempt.attempt_id);
      // The enclosing control transaction can still roll back. Keep the source
      // until a later cleanup observes a committed terminal state.
    } catch (error) {
      if (dispatch?.created) new MemoryCandidateDispatchSpool(dispatchRoot).remove(dispatch);
      throw error;
    }
    return true;
  }
}

function requiredText(value: string | null): string {
  if (value === null || value.length === 0) throw new Error("MEMORY_TARGET_UNRESOLVED");
  return value;
}

function parseExpectedPrior(value: string | null): Readonly<Record<string, string>> {
  if (value === null) throw new Error("MEMORY_TARGET_UNRESOLVED");
  const parsed: unknown = JSON.parse(value);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)
    || typeof Reflect.get(parsed, "source_id") !== "string"
    || typeof Reflect.get(parsed, "source_version") !== "string"
    || typeof Reflect.get(parsed, "source_digest") !== "string") {
    throw new Error("MEMORY_TARGET_UNRESOLVED");
  }
  return {
    source_id: String(Reflect.get(parsed, "source_id")),
    source_version: String(Reflect.get(parsed, "source_version")),
    source_digest: String(Reflect.get(parsed, "source_digest")),
  };
}
