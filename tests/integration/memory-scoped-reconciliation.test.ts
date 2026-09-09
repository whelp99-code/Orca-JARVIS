import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from 'vitest';
import { scopedOutboxFixture } from '../fixtures/scoped-outbox.js';
import { closeMemoryDatabase } from '../fixtures/memory-candidate-store.js';
import { registerMemoryScopedOutbox } from '../../src/memory-scoped-outbox.js';
import { claimMemoryScopedOutbox, markMemoryScopedOutboxDispatch, recoverMemoryScopedOutboxDispatches } from '../../src/memory-scoped-outbox-worker.js';
import { claimMemoryScopedReconciliation, readMemoryScopedReconciliationRequest,
  requireMemoryScopedReconciliationLease, releaseMemoryScopedReconciliation } from '../../src/memory-scoped-reconciliation.js';

it('reconstructs an expired spent request and fences reconciliation without another dispatch', async () => {
  const f = await scopedOutboxFixture();
  try {
    const r = registerMemoryScopedOutbox(f.options, f.claimed);
    const options = { ...f.options, roots: f.dispatch.roots };
    expect(claimMemoryScopedReconciliation(options, r.outbox_id, 'worker:read', f.now, 1000)).toBeUndefined();
    const original = claimMemoryScopedOutbox(options, r.outbox_id, 'worker:send', 1000)!;
    const dispatch = markMemoryScopedOutboxDispatch(options, original, 30000);
    const late = new Date(Date.parse(dispatch.request.expires_at) + 1);
    expect(recoverMemoryScopedOutboxDispatches(f.database.authority, late)).toBe(1);
    expect(readMemoryScopedReconciliationRequest(options, r.outbox_id, late)).toEqual(dispatch.request);
    const first = claimMemoryScopedReconciliation(options, r.outbox_id, 'worker:one', late, 1000)!;
    expect(first.request).toEqual(dispatch.request);
    expect(first.lease.dispatch_fence).toBe(original.fence);
    expect(first.lease.fence).toBeGreaterThan(original.fence);
    requireMemoryScopedReconciliationLease(f.database.authority, first.lease, late);
    expect(claimMemoryScopedReconciliation(options, r.outbox_id, 'worker:two', late, 1000)).toBeUndefined();
    const next = new Date(late.getTime() + 1000);
    const second = claimMemoryScopedReconciliation(options, r.outbox_id, 'worker:two', next, 1000)!;
    expect(second.lease.fence).toBe(first.lease.fence + 1);
    expect(() => releaseMemoryScopedReconciliation(f.database.authority, first.lease, next)).toThrow('MEMORY_OUTBOX_STALE_FENCE');
    expect(() => requireMemoryScopedReconciliationLease(f.database.authority, second.lease, late)).toThrow();
    releaseMemoryScopedReconciliation(f.database.authority, second.lease, next);
    expect(() => requireMemoryScopedReconciliationLease(f.database.authority, second.lease, next)).toThrow();
    expect(claimMemoryScopedOutbox({ ...options, clock: () => next }, r.outbox_id, 'worker:resend', 1000)).toBeUndefined();
    expect(f.database.authority.db.prepare('SELECT count(*) AS n FROM memory_outbox_attempts').get()).toEqual({ n: 1 });
    expect(f.database.authority.db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  } finally { closeMemoryDatabase(f.database); }
});
it.each(['provider', 'fence', 'time', 'body', 'duration', 'worker', 'updated'])( 'rejects %s without taking a reconciliation lease', async mode => {
  const f = await scopedOutboxFixture();
  try {
    const r = registerMemoryScopedOutbox(f.options, f.claimed), options = { ...f.options, roots: f.dispatch.roots };
    const lease = claimMemoryScopedOutbox(options, r.outbox_id, 'worker:send', 1000)!;
    const dispatch = markMemoryScopedOutboxDispatch(options, lease, 30000);
    const late = new Date(Date.parse(dispatch.request.expires_at) + 1);
    recoverMemoryScopedOutboxDispatches(f.database.authority, late);
    if (mode === 'updated') f.database.authority.db.prepare("UPDATE memory_outbox SET updated_at='0'").run();
    if (mode === 'fence') f.database.authority.db.prepare('UPDATE memory_outbox SET dispatch_fence=dispatch_fence+1').run();
    if (mode === 'body') {
      expect(() => f.database.authority.db.prepare("UPDATE memory_outbox SET expected_sid='ffffffff'").run()).toThrow();
      const path = join(options.spoolRoot, dispatch.request.idempotency_key.slice(-64) + '.v4.json');
      chmodSync(path, 0o600); writeFileSync(path, '{}');
    }
    const before = f.database.authority.db.prepare('SELECT lease_fence,lease_owner FROM memory_outbox').get();
    expect(() => claimMemoryScopedReconciliation({ ...options, providerInstanceId: mode === 'provider' ? 'provider:other' : options.providerInstanceId },
      r.outbox_id, mode === 'worker' ? 'bad worker' : 'worker:read', mode === 'time' ? f.now : late, mode === 'duration' ? 0 : 1000)).toThrow();
    expect(f.database.authority.db.prepare('SELECT lease_fence,lease_owner FROM memory_outbox').get()).toEqual(before);
  } finally { closeMemoryDatabase(f.database); }
});
