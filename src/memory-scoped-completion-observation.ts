import { canonicalize } from "./canonical.js";
import { JarvisError } from "./db.js";
import { memoryHash } from "./memory-candidate-values.js";
import type { createMemoryScopedClient } from "./memory-scoped-client.js";
import { recordMemoryScopedOutboxAcceptance } from "./memory-scoped-outbox-result.js";
import { readMemoryScopedReconciliationRequest, requireMemoryScopedReconciliationLease,
  type MemoryScopedReconcileLease, type MemoryScopedReconcileOptions } from "./memory-scoped-reconciliation.js";

/** Trusted client composition; do not supply an untrusted callback or deserialize
 * an observation into this port. Network reads finish before the DB transaction.
 * Records an observation only, never task success or current provider authority. */
export async function observeMemoryScopedCompletion(options: MemoryScopedReconcileOptions,
  lease: MemoryScopedReconcileLease, client: Pick<ReturnType<typeof createMemoryScopedClient>, "withRememberedCompletion">,
  now: () => Date, signal?: AbortSignal) {
  const request = readMemoryScopedReconciliationRequest(options, lease.outbox_id, now());
  return client.withRememberedCompletion(request, (observation, refresh) => {
    const db = options.authority.db;
    return db.transaction(() => {
      const check = () => {
        const current = refresh(), at = new Date(now().getTime());
        if (!Number.isFinite(at.getTime()) || at.getTime() < Date.parse(current.checked_at)
          || !(at.getTime() < Date.parse(current.valid_until))) throw new JarvisError("SCOPED_COMPLETION_OBSERVATION_INVALID");
        requireMemoryScopedReconciliationLease(options.authority, lease, at);
        if (canonicalize(readMemoryScopedReconciliationRequest(options, lease.outbox_id, at)) !== canonicalize(request))
          throw new JarvisError("SCOPED_COMPLETION_OBSERVATION_INVALID");
        return { current, at };
      };
      const { current, at } = check();
      if (observation.request_id !== request.request_id || observation.request_digest !== request.request_digest)
        throw new JarvisError("SCOPED_COMPLETION_OBSERVATION_INVALID");
      const accepted = recordMemoryScopedOutboxAcceptance(options.authority, lease.outbox_id, lease.dispatch_fence,
        request, observation.status.acceptance, at);
      const evidence = { schema_version: 1, outbox_id: lease.outbox_id, attempt_id: accepted.attempt_id,
        dispatch_fence: lease.dispatch_fence, reconcile_fence: lease.fence,
        request_id: request.request_id, request_digest: request.request_digest,
        scope_digest: request.preparation.binding.identity_digest,
        acceptance_receipt_digest: accepted.acceptance_receipt_digest,
        status: observation.status, artifact: observation.artifact };
      const raw = canonicalize(evidence);
      const digest = memoryHash("orca-jarvis/memory-scoped-completion-observation/v1\0", evidence);
      const id = `memobs:scoped:v1:${digest.slice(7)}`;
      const existing = db.prepare(`SELECT observation_id,evidence_digest,evidence_json FROM memory_scoped_completion_observations
        WHERE outbox_id=? AND reconcile_fence=?`).get(lease.outbox_id, lease.fence) as
        { observation_id: string; evidence_digest: string; evidence_json: string } | undefined;
      if (existing !== undefined) {
        if (existing.observation_id !== id || existing.evidence_digest !== digest || existing.evidence_json !== raw)
          throw new JarvisError("SCOPED_COMPLETION_OBSERVATION_CONFLICT");
      } else db.prepare(`INSERT INTO memory_scoped_completion_observations
        (observation_id,outbox_id,attempt_id,reconcile_fence,dispatch_fence,evidence_digest,evidence_json,observed_at,authorized_until)
        VALUES(?,?,?,?,?,?,?,?,?)`).run(id, lease.outbox_id, accepted.attempt_id, lease.fence, lease.dispatch_fence,
          digest, raw, at.toISOString(), current.valid_until);
      const final = check(); // Revocation rolls back acceptance too.
      if (final.at < at || final.current.valid_until < current.valid_until)
        throw new JarvisError("SCOPED_COMPLETION_OBSERVATION_INVALID");
      return Object.freeze({ kind: "completion_observation_recorded" as const, observation_id: id,
        outbox_id: lease.outbox_id, evidence_digest: digest, replayed: existing !== undefined });
    }).immediate();
  }, signal);
}
