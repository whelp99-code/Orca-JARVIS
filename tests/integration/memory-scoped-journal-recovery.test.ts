import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { canonicalize } from "../../src/canonical.js";
import { createProductionMemoryAccessClaim } from "../../src/memory-access-claim-production.js";
import { memoryHash } from "../../src/memory-candidate-values.js";
import { createMemoryScopedJournalClient } from "../../src/memory-scoped-journal-client.js";
import { recoverMemoryScopedJournalAcceptance } from "../../src/memory-scoped-journal-recovery.js";
import { registerMemoryScopedOutbox } from "../../src/memory-scoped-outbox.js";
import { claimMemoryScopedOutbox, markMemoryScopedOutboxDispatch, recoverMemoryScopedOutboxDispatches } from "../../src/memory-scoped-outbox-worker.js";
import { claimMemoryScopedReconciliation } from "../../src/memory-scoped-reconciliation.js";
import type { SecondBrainTransport } from "../../src/second-brain-transport.js";
import { scopedOutboxFixture } from "../fixtures/scoped-outbox.js";
import { closeMemoryDatabase } from "../fixtures/memory-candidate-store.js";
import { memoryReadFenceFixture } from "../fixtures/memory-read-fence.js";

it.each(['pending', 'failed', 'not_found', 'stale_before', 'stale_after', 'revoke_after', 'cancel_after'])(
  'recovers only the original acceptance: %s', async mode => {
  const f = await scopedOutboxFixture();
  try {
    const db = f.database.authority.db;
    const registered = registerMemoryScopedOutbox(f.options, f.claimed);
    const dispatchOptions = { ...f.options, roots: f.dispatch.roots };
    const dispatchLease = claimMemoryScopedOutbox(dispatchOptions, registered.outbox_id, 'worker:fixture', 1000)!;
    const dispatched = markMemoryScopedOutboxDispatch(dispatchOptions, dispatchLease, 30000);
    const request = dispatched.request, accepted_at = f.now.toISOString();
    const accepted = { schema_version: 4, kind: 'accepted', state: 'pending', provider_instance_id: request.provider_instance_id,
      request_id: request.request_id, request_digest: request.request_digest, idempotency_key: request.idempotency_key,
      scope_digest: request.preparation.binding.identity_digest, accepted_at, inbox_path: `pending/${request.request_id}.v4.json`,
      request_file_digest: memoryHash('second-brain/inbox-write-request/v4\0', { schema_version: 4, state: 'pending', accepted_at, request }), replayed: true };
    let now = new Date('2026-08-31T03:30:00.000Z');
    expect(recoverMemoryScopedOutboxDispatches(f.database.authority, now)).toBe(1);
    const options = { authority: f.database.authority, spoolRoot: f.options.spoolRoot, providerInstanceId: 'provider:fixture' };
    const claimed = claimMemoryScopedReconciliation(options, registered.outbox_id, 'worker:recover', now, 10000)!;
    const { config } = memoryReadFenceFixture(f.database);
    const controller = new AbortController();
    const scope = { principal_id: 'principal:owner' as const, agent_id: 'agent:reader', session_id: 'session:reader',
      projects: request.preparation.binding.identity.projects, policy_revision: request.preparation.binding.identity.policy_revision,
      valid_until: new Date(now.getTime() + 60000).toISOString() };
    let sends = 0;
    const transport: SecondBrainTransport = {
      async call(method, args, opt) {
        expect(method).toBe('sb_request_status'); opt?.beforeSend?.(); sends++;
        const claim = args.access_claim as Record<string, unknown>, fence = args.read_fence as Record<string, unknown>;
        const status = { schema_version: 4, provider_instance_id: request.provider_instance_id, request_id: request.request_id,
          request_digest: request.request_digest, scope_digest: request.preparation.binding.identity_digest,
          state: mode === 'failed' ? 'failed' : mode === 'not_found' ? 'not_found' : 'pending',
          ...(mode === 'not_found' ? {} : { phase: null, updated_at: accepted_at, acceptance: accepted }) };
        return { kind: 'data', value: { profile: 'scoped-request-status-v1', request_digest: claim.request_digest,
          access_claim_digest: 'sha256:' + createHash('sha256').update('orca-jarvis/memory-access-claim-binding/v1\0' + canonicalize(claim)).digest('hex'),
          provider_instance_id: 'provider:fixture', tombstone_sequence: fence.tombstone_sequence, tombstone_set_root: fence.tombstone_set_root,
          request_status: status } };
      }, async close() {}, async restart() {}, diagnostics: () => [],
    };
    const client = createMemoryScopedJournalClient({ transport, now: () => now,
      issue: createProductionMemoryAccessClaim(f.database.authority, config, () => {
        const stored = db.prepare("SELECT outcome FROM memory_outbox_attempts").get() as { outcome: string };
        if (stored.outcome === 'accepted') {
          if (mode === 'revoke_after') return undefined;
          if (mode === 'stale_after') now = new Date(claimed.lease.lease_expires_at);
          if (mode === 'cancel_after') controller.abort();
        }
        return scope;
      }, 'memory_status'), budgets: { max_hits: 1, max_excerpt_bytes: 8192, max_total_bytes: 100000, max_page_bytes: 100000 } });
    if (mode === 'stale_before') now = new Date(claimed.lease.lease_expires_at);
    const run = () => recoverMemoryScopedJournalAcceptance(options, claimed.lease, client, () => now, controller.signal);
    if (['stale_before', 'stale_after', 'revoke_after', 'cancel_after'].includes(mode)) {
      await expect(run()).rejects.toThrow();
      expect(db.prepare('SELECT outcome,accepted_result_json FROM memory_outbox_attempts').get()).toEqual({ outcome: 'dispatching', accepted_result_json: null });
      expect(db.prepare("SELECT count(*) AS n FROM memory_reconciliation_events WHERE event_type='provider_accepted'").get()).toEqual({ n: 0 });
      expect(sends).toBe(mode === 'stale_before' ? 0 : 1);
    } else if (mode === 'not_found') {
      expect((await run()).kind).toBe('scoped_journal_not_found');
      expect(db.prepare('SELECT outcome FROM memory_outbox_attempts').get()).toEqual({ outcome: 'dispatching' });
    } else {
      const first = await run(); expect(first.kind).toBe('scoped_journal_acceptance_recovered');
      if (first.kind !== 'scoped_journal_acceptance_recovered') throw Error('expected acceptance');
      expect(first.acceptance.replayed).toBe(false);
      const again = await run();
      expect(again).toEqual({ ...first, acceptance: { ...first.acceptance, replayed: true } });
      expect(db.prepare("SELECT count(*) AS n FROM memory_reconciliation_events WHERE event_type='provider_accepted'").get()).toEqual({ n: 1 });
      let saved: (() => unknown) | undefined;
      await client.withRecoveredRequestStatus(request, (_value, refresh) => { saved = refresh; expect(refresh().status.state).toBe(mode); });
      expect(() => saved!()).toThrow('MEMORY_SCOPED_JOURNAL_UNAVAILABLE');
    }
    expect(db.prepare('SELECT count(*) AS n FROM memory_outbox_attempts').get()).toEqual({ n: 1 });
    expect(db.prepare('SELECT state FROM memory_outbox').get()).toEqual({ state: 'reconciling' });
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  } finally { closeMemoryDatabase(f.database); }
});
