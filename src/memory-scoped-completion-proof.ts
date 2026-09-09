import { canonicalize } from "./canonical.js";
import { JarvisError } from "./db.js";
import { memoryHash } from "./memory-candidate-values.js";
import { memoryOutboxHash } from "./memory-outbox-values.js";
import { readMemoryScopedReconciliationRequest, type MemoryScopedReconcileOptions } from "./memory-scoped-reconciliation.js";
import { parseSecondBrainRecoveredRequestStatus } from "./second-brain-scoped-request-status.js";
import { parseSecondBrainScopedWriteAccepted } from "./second-brain-scoped-write-result.js";
import { rememberedArtifactExpectation } from "./second-brain-remembered-artifact.js";
import { secondBrainGenerationBinding } from "./second-brain-generation-read.js";
import { parseSecondBrainPageAccess } from "./second-brain-page-access.js";

const fail = (): never => { throw new JarvisError("SCOPED_COMPLETION_EVIDENCE_INVALID"); };
function object(value: unknown, keys: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype
    || Object.keys(value).sort().join(" ") !== keys) return fail();
  return value as Record<string, unknown>;
}
function instant(value: unknown): Date {
  if (typeof value !== "string") return fail();
  const at = new Date(value);
  if (!Number.isFinite(at.getTime()) || at.toISOString() !== value) return fail();
  return at;
}

/** Reconstruct historical evidence from the trusted local ledger and original
 * private spool. Expired read authority is history, never renewed permission.
 * Does not establish current visibility, original command authority, or success. */
export function readMemoryScopedCompletionProof(options: MemoryScopedReconcileOptions, observationId: string, now: Date) {
  try {
    if (!Number.isFinite(now.getTime())) return fail();
    return options.authority.db.transaction(() => {
      const db = options.authority.db;
      const row = db.prepare(`SELECT e.*,o.lease_fence AS current_fence,o.dispatch_fence AS original_fence,
        a.accepted_result_json,a.acceptance_receipt_digest,a.outcome,a.completed_at,a.dispatched_at
        FROM memory_scoped_completion_observations e JOIN memory_outbox o ON o.outbox_id=e.outbox_id
        JOIN memory_outbox_attempts a ON a.attempt_id=e.attempt_id AND a.outbox_id=e.outbox_id
        AND a.dispatch_fence=e.dispatch_fence WHERE e.observation_id=? AND o.request_profile='scoped-v4'`)
        .get(observationId) as Record<string, any> | undefined;
      if (row === undefined || row.outcome !== "accepted" || row.original_fence !== row.dispatch_fence
        || !Number.isSafeInteger(row.reconcile_fence) || row.reconcile_fence < 1
        || row.reconcile_fence > row.current_fence) return fail();
      const observed = instant(row.observed_at), until = instant(row.authorized_until);
      if (observed > now || until <= observed || instant(row.completed_at) > observed) return fail();
      const request = readMemoryScopedReconciliationRequest(options, row.outbox_id, now);
      const evidence = object(JSON.parse(row.evidence_json), "acceptance_receipt_digest artifact attempt_id dispatch_fence outbox_id reconcile_fence request_digest request_id schema_version scope_digest status");
      const digest = memoryHash("orca-jarvis/memory-scoped-completion-observation/v1\0", evidence);
      if (canonicalize(evidence) !== row.evidence_json || digest !== row.evidence_digest
        || observationId !== `memobs:scoped:v1:${digest.slice(7)}` || evidence.schema_version !== 1
        || evidence.outbox_id !== row.outbox_id || evidence.attempt_id !== row.attempt_id
        || evidence.dispatch_fence !== row.dispatch_fence || evidence.reconcile_fence !== row.reconcile_fence
        || evidence.request_id !== request.request_id || evidence.request_digest !== request.request_digest
        || evidence.scope_digest !== request.preparation.binding.identity_digest
        || evidence.acceptance_receipt_digest !== row.acceptance_receipt_digest) return fail();
      const accepted = parseSecondBrainScopedWriteAccepted(JSON.parse(row.accepted_result_json), request, observed);
      if (instant(accepted.accepted_at) < instant(row.dispatched_at) || instant(row.completed_at) < instant(accepted.accepted_at)
        || accepted.replayed || canonicalize(accepted) !== row.accepted_result_json
        || memoryOutboxHash("memory-outbox-acceptance", accepted) !== row.acceptance_receipt_digest) return fail();
      const event = db.prepare(`SELECT * FROM memory_reconciliation_events WHERE outbox_id=? AND event_type='provider_accepted'`)
        .get(row.outbox_id) as Record<string, any> | undefined;
      if (event === undefined || event.attempt_id !== row.attempt_id || event.reconcile_fence !== row.dispatch_fence
        || event.outcome_code !== null || event.page_id !== null || event.sid !== null || event.source_version !== null
        || event.observed_artifact_digest !== null || instant(event.created_at) > observed
        || event.created_at !== row.completed_at) return fail();
      const eventDigest = memoryOutboxHash("memory-outbox-event", { outbox_id: row.outbox_id,
        attempt_id: row.attempt_id, reconcile_fence: row.dispatch_fence, event_type: "provider_accepted",
        outcome_code: null, receipt_digest: row.acceptance_receipt_digest, created_at: event.created_at });
      if (event.effect_digest !== eventDigest || event.event_id !== `event:memory-outbox:v2:${eventDigest.slice(7)}`) return fail();
      const status = parseSecondBrainRecoveredRequestStatus(evidence.status, request, observed, accepted);
      if (status.state !== "proved") return fail();
      const expected = rememberedArtifactExpectation(request, accepted, observed);
      const artifact = object(evidence.artifact, "access content_digest generation kind page_id record_ids request_digest request_id");
      const generation = secondBrainGenerationBinding({ __generation_binding: artifact.generation });
      const access = parseSecondBrainPageAccess(artifact.access, { owner: expected.owner,
        projects: expected.projects, policy_revision: expected.policy });
      if (artifact.kind !== "remembered_artifact_observed" || artifact.request_id !== request.request_id
        || artifact.request_digest !== request.request_digest || artifact.page_id !== expected.page_id
        || !/^sha256:[0-9a-f]{64}$/.test(String(artifact.content_digest))
        || generation === undefined || generation.provider_instance_id !== expected.provider || generation.tombstone_sequence < 0
        || generation.generation_id !== `sbgen:v1:${generation.generation_manifest_digest.slice(7)}`
        || access.sources.length !== 1 || access.sources[0]!.source_ref_digest !== expected.source_ref_digest
        || canonicalize(access.sources[0]!.classification.projects) !== canonicalize(expected.projects)
        || !Array.isArray(artifact.record_ids) || artifact.record_ids.length !== expected.lines.length
        || new Set(artifact.record_ids).size !== artifact.record_ids.length
        || artifact.record_ids.some(id => typeof id !== "string" || !/^sbrecord:v1:[0-9a-f]{64}$/.test(id))) return fail();
      return Object.freeze({ kind: "completion_evidence_consistent" as const, observation_id: observationId,
        outbox_id: row.outbox_id as string, evidence_digest: digest, observed_at: row.observed_at as string,
        authorized_until: row.authorized_until as string,
        evidence: Object.freeze({ ...evidence, status, artifact: Object.freeze({ ...artifact, access,
          generation: Object.freeze(generation), record_ids: Object.freeze([...artifact.record_ids]) }) }) });
    }).immediate();
  } catch { return fail(); }
}
