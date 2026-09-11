import { candidateTaskSourceSuppressed } from "../memory-candidate-task-source.js";
import { MemoryProjectionAuthority } from "../memory-projection-authority.js";
import { createHash } from "node:crypto";
import { canonicalize } from "../canonical.js";
import { JarvisError } from "../db.js";
import type { ControlPlane, StoredControlCommand } from "../control-plane.js";
import type { MemoryCandidateReviewSpool } from "../memory-candidate-review-spool.js";
import type { MemoryTokenSelection } from "./memory-token-cache.js";
import type { MemoryMutationOptions } from "./memory-mutation-service.js";

/** Owner confirmation staging for a reviewed memory candidate. */
const hash = (domain: string, value: unknown): string => `sha256:${createHash("sha256")
  .update(domain).update(canonicalize(value)).digest("hex")}`;

export type MemoryCandidateDecisionInput = {
  readonly candidate_id: string;
  readonly operation: "remember" | "correct";
  readonly decision: "confirm" | "reject";
  readonly intent_id: string;
  readonly token?: string;
  readonly record_revision?: string;
};

type CorrectionSelection = {
  readonly targetVersion: string; readonly expectedPrior: string; readonly targetManifest: string;
  readonly scopeDigest: string; readonly recordMembership: string;
  readonly expectedPriorRecord: Readonly<Record<string, string>>;
  readonly selection: MemoryTokenSelection;
};

type TargetInsert = {
  readonly targetVersion: string; readonly expectedPrior: string; readonly targetManifest: string;
  readonly scopeDigest: string; readonly recordMembership: string; readonly privacyEpoch: number;
  readonly at: Date;
};

export type MemoryCandidateDecisionHost = {
  readonly options: MemoryMutationOptions;
  readonly control: ControlPlane;
  readonly review: MemoryCandidateReviewSpool | undefined;
  correctionSelection(
    input: { readonly token?: string; readonly record_revision?: string },
    privacyEpoch: number,
  ): CorrectionSelection;
  insertTarget(selection: MemoryTokenSelection, target: TargetInsert): void;
};

export function stageMemoryCandidateDecision(
host: MemoryCandidateDecisionHost,
input: MemoryCandidateDecisionInput,
): StoredControlCommand | undefined {
  const requireVisible = () => {
    if (input.decision !== "confirm") return;
    // Hiding the work hides what confirming it would store, including a decision prepared while
    // the task was still visible: the candidate itself may be untouched and still not confirmable.
    if (new MemoryProjectionAuthority(host.options.authority).isProjectionIdSuppressed(input.candidate_id)
      || candidateTaskSourceSuppressed(host.options.authority, input.candidate_id)) {
      throw new JarvisError("MEMORY_CANDIDATE_SUPPRESSED");
    }
  };
  requireVisible();
  const row = host.options.authority.db.prepare(
    `SELECT c.candidate_id,c.operation,c.state,c.expires_at,c.confirmation_expires_at,
        c.content_digest,m.candidate_digest,m.classification_digest
     FROM memory_candidates c JOIN memory_candidate_classifications m ON m.candidate_id=c.candidate_id
     WHERE c.candidate_id=?`,
  ).get(input.candidate_id) as {
    readonly candidate_id: string; readonly operation: "remember" | "correct"; readonly state: string;
    readonly expires_at: string; readonly confirmation_expires_at: string | null;
    readonly candidate_digest: string; readonly classification_digest: string; readonly content_digest: string;
  } | undefined;
  if (row === undefined) return undefined;
  if (row.operation !== input.operation || row.state !== "awaiting_confirmation") {
    throw new JarvisError("MEMORY_STATE_CONFLICT");
  }
  const expiresAt = row.confirmation_expires_at ?? row.expires_at;
  const now = host.options.clock();
  if (Date.parse(expiresAt) <= now.getTime() || Date.parse(row.expires_at) <= now.getTime()) {
    throw new JarvisError("MEMORY_CANDIDATE_EXPIRED");
  }
  if (host.review === undefined) throw new JarvisError("MEMORY_REVIEW_UNAVAILABLE");
  const review = host.review.read(row.candidate_id);
  if (review.candidate_digest !== row.candidate_digest
    || review.classification_digest !== row.classification_digest
    || review.content_digest !== row.content_digest
    || review.operation !== row.operation) {
    throw new JarvisError("MEMORY_REVIEW_UNAVAILABLE");
  }
  const authority = host.options.authority.db.prepare(
    "SELECT privacy_epoch FROM memory_surface_authority WHERE singleton_id=1",
  ).get() as { readonly privacy_epoch: number };
  const selection = input.operation === "correct"
    ? host.correctionSelection(input, authority.privacy_epoch)
    : undefined;
  const active = host.options.authority.db.prepare(
    `SELECT f.decision,a.control_request_id FROM memory_candidate_decision_attempts a
     JOIN memory_candidate_decision_families f ON f.family_digest=a.family_digest
     WHERE f.candidate_id=? AND a.state IN ('staged','approved')`,
  ).get(row.candidate_id) as { readonly decision: "confirm" | "reject"; readonly control_request_id: string } | undefined;
  if (active !== undefined && active.decision !== input.decision) {
    throw new JarvisError("MEMORY_STATE_CONFLICT");
  }
  const family = hash("orca-jarvis/memory-ui-candidate-family/v1\0", {
    candidate_id: row.candidate_id, candidate_digest: row.candidate_digest,
    classification_digest: row.classification_digest, operation: row.operation,
    decision: input.decision, content_digest: row.content_digest,
  });
  const prior = host.options.authority.db.prepare(
    `SELECT attempt_id,attempt_generation,state FROM memory_candidate_decision_attempts
     WHERE family_digest=? ORDER BY attempt_generation DESC LIMIT 1`,
  ).get(family) as { readonly attempt_id: string; readonly attempt_generation: number; readonly state: string } | undefined;
  if (active !== undefined && prior !== undefined && ["staged", "approved"].includes(prior.state)) {
    const existing = host.control.get(active.control_request_id);
    if (existing !== undefined) return existing;
  }
  const generation = (prior?.attempt_generation ?? 0) + 1;
  const attemptId = `memui:candidate-attempt:v1:${hash("orca-jarvis/memory-ui-candidate-attempt/v1\0", {
    family, generation, predecessor: prior?.attempt_id ?? null, intent_id: input.intent_id,
  }).slice(7)}`;
  const requestId = `memui:candidate-control:v1:${hash("orca-jarvis/memory-ui-candidate-control/v1\0", attemptId).slice(7)}`;
  const at = now.toISOString();
  const expires = new Date(Math.min(now.getTime() + 15 * 60_000, Date.parse(expiresAt))).toISOString();
  const freshSelection = hash("orca-jarvis/memory-ui-candidate-selection/v1\0", {
    family, generation, privacy_epoch: authority.privacy_epoch, intent_id: input.intent_id,
    selection: selection?.targetVersion ?? null,
  });
  return host.options.authority.db.transaction(() => {
    requireVisible();
    host.options.authority.db.prepare(
      `INSERT OR IGNORE INTO memory_candidate_decision_families(
        family_digest,candidate_id,candidate_digest,classification_digest,decision,content_digest,created_at
      ) VALUES(?,?,?,?,?,?,?)`,
    ).run(family, row.candidate_id, row.candidate_digest, row.classification_digest,
      input.decision, row.content_digest, at);
    if (selection !== undefined) {
      host.insertTarget(selection.selection, {
        targetVersion: selection.targetVersion, expectedPrior: selection.expectedPrior,
        targetManifest: selection.targetManifest, scopeDigest: selection.scopeDigest,
        recordMembership: selection.recordMembership, privacyEpoch: authority.privacy_epoch, at: now,
      });
    }
    const command = host.control.stage({
      schema_version: 1, request_id: requestId, action: "memory.confirm", action_level: 3,
      target: { candidate_id: row.candidate_id, candidate_digest: row.candidate_digest,
        classification_digest: row.classification_digest },
      args: { schema_version: 1, operation: row.operation, decision: input.decision,
        content_digest: row.content_digest, review_spool_digest: review.review_envelope_digest },
      reversible: false, requested_by: "principal:owner", requested_at: at, expires_at: expires,
      nonce: attemptId,
    }, now);
    host.options.authority.db.prepare(
      `INSERT INTO memory_candidate_decision_attempts(
        attempt_id,family_digest,attempt_generation,fresh_selection_digest,predecessor_attempt_id,
        control_request_id,state,created_at,updated_at,target_version_digest,expected_prior_digest,
        target_manifest_digest,scope_digest,expected_prior_json
      ) VALUES(?,?,?,?,?,?, 'staged',?,?,?,?,?,?,?)`,
    ).run(attemptId, family, generation, freshSelection, prior?.attempt_id ?? null, requestId,
      at, at, selection?.targetVersion ?? null, selection?.expectedPrior ?? null,
      selection?.targetManifest ?? null, selection?.scopeDigest ?? null,
      selection === undefined ? null : canonicalize(selection.expectedPriorRecord));
    return command;
  }).immediate();
}
