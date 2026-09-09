import { expect, it } from "vitest";
import { reconcileMemoryScopedOnce } from "../../src/memory-scoped-reconcile-once.js";
import { releaseMemoryScopedReconciliation } from "../../src/memory-scoped-reconciliation.js";
import { completionObservationFixture } from "../fixtures/scoped-completion-observation.js";
import { closeMemoryDatabase } from "../fixtures/memory-candidate-store.js";

it.each(['pending', 'failed', 'not_found', 'proved', 'busy', 'cancelled', 'read_error', 'completion_error'])(
  'one reconciliation pass preserves %s semantics', async mode => {
  const f = await completionObservationFixture();
  try {
    const db = f.database.authority.db, outbox = f.dispatch.outbox_id;
    if (mode !== 'busy') releaseMemoryScopedReconciliation(f.database.authority, f.leased.lease, f.at);
    let journalCalls = 0, completionCalls = 0;
    const controller = new AbortController();
    if (mode === 'cancelled') controller.abort();
    const options = { ...f.options, clock: () => f.at,
      roots: { candidate_dispatch_spool_root: f.options.dispatch.roots.dispatch, candidate_review_spool_root: f.options.dispatch.roots.review },
      journal: { withRecoveredRequestStatus: async (_request: unknown, consume: any) => {
        journalCalls++;
        if (mode === 'read_error') throw Error('read unavailable');
        const status = { ...f.observation.status, state: ['proved', 'completion_error'].includes(mode) ? 'proved' : mode };
        const observation = { kind: 'scoped_journal_status_observed', status,
          checked_at: f.observation.checked_at, valid_until: f.observation.valid_until };
        return consume(observation, () => observation);
      } },
      completion: { withRememberedCompletion: async (_request: unknown, consume: any) => {
        completionCalls++;
        if (mode === 'completion_error') throw Error('artifact unavailable');
        return consume(f.observation, () => f.observation);
      } },
    };
    const run = () => reconcileMemoryScopedOnce(options, outbox, 'worker:once', 10000, controller.signal);
    if (['cancelled', 'read_error', 'completion_error'].includes(mode)) {
      await expect(run()).rejects.toThrow();
      expect(db.prepare('SELECT state FROM memory_outbox').get()).toEqual({ state: 'reconciling' });
      if (mode !== 'cancelled') expect((db.prepare('SELECT lease_owner FROM memory_outbox').get() as any).lease_owner).toBe('worker:once');
    } else if (mode === 'busy') {
      expect((await run()).kind).toBe('scoped_reconciliation_not_claimed');
    } else if (mode === 'proved') {
      const result = await run(); expect(result.kind).toBe('memory_scoped_settled');
      expect(await run()).toEqual({ ...result, replayed: true });
      expect(db.prepare('SELECT count(*) AS n FROM memory_scoped_settlements').get()).toEqual({ n: 1 });
    } else {
      const result = await run(); expect(result.kind).toBe('scoped_reconciliation_deferred');
      if (result.kind !== 'scoped_reconciliation_deferred') throw Error('expected deferred');
      expect(result.observed_provider_state).toBe(mode);
      expect(db.prepare('SELECT state,lease_owner,lease_expires_at FROM memory_outbox').get()).toEqual({ state: 'reconciling', lease_owner: null, lease_expires_at: null });
    }
    expect(journalCalls).toBe(['busy', 'cancelled'].includes(mode) ? 0 : 1);
    expect(completionCalls).toBe(['proved', 'completion_error'].includes(mode) ? 1 : 0);
    expect(db.prepare('SELECT count(*) AS n FROM memory_outbox_attempts').get()).toEqual({ n: 1 });
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  } finally { closeMemoryDatabase(f.database); }
});
