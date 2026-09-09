import { expect, it } from "vitest";
import { scopedOutboxFixture } from "../fixtures/scoped-outbox.js";
import { closeMemoryDatabase } from "../fixtures/memory-candidate-store.js";
import { registerMemoryScopedOutbox } from "../../src/memory-scoped-outbox.js";
import { readCurrentMemoryScopedOutbox, readCurrentDispatchedMemoryScopedOutbox } from "../../src/memory-scoped-outbox-reader.js";
import { claimMemoryScopedOutbox, markMemoryScopedOutboxDispatch, recoverMemoryScopedOutboxDispatches } from "../../src/memory-scoped-outbox-worker.js";
import { verifyMemoryScopedProviderWrite } from "../../src/memory-scoped-provider-authority.js";
import { hasRegisteredScopedSourceAuthority, hasSecondBrainWriteAuthority } from "../../src/second-brain-write-authority.js";

it('checks the original dispatched attempt with current policy and consumed reviews without spending again', async () => {
  const f = await scopedOutboxFixture();
  try {
    const registration = registerMemoryScopedOutbox(f.options, f.claimed);
    let now = f.now;
    const options = { ...f.options, roots: f.dispatch.roots, clock: () => now };
    const pending = readCurrentMemoryScopedOutbox(options, registration.outbox_id);
    expect(() => verifyMemoryScopedProviderWrite(options, pending)).toThrow();
    const lease = claimMemoryScopedOutbox(options, registration.outbox_id, 'worker:fixture', 1000)!;
    const dispatch = markMemoryScopedOutboxDispatch(options, lease, 20000);
    expect(() => readCurrentMemoryScopedOutbox(options, registration.outbox_id)).toThrow();
    expect(hasRegisteredScopedSourceAuthority(f.database.authority, pending.source_request, registration.outbox_id, now)).toBe(false);
    expect(hasSecondBrainWriteAuthority(f.database.authority, pending.source_request, now)).toBe(false);
    expect(readCurrentDispatchedMemoryScopedOutbox(options, registration.outbox_id, dispatch.fence)).toEqual(pending);
    const result = verifyMemoryScopedProviderWrite(options, pending);
    expect(result.kind).toBe('current_scoped_dispatch');
    expect(result.request_digest).toBe(pending.request_digest);
    expect(Object.isFrozen(result)).toBe(true);
    now = new Date(f.now.getTime() + 1001);
    expect(recoverMemoryScopedOutboxDispatches(f.database.authority, now)).toBe(1);
    expect(verifyMemoryScopedProviderWrite(options, pending).dispatch_fence).toBe(dispatch.fence);
    expect(claimMemoryScopedOutbox(options, registration.outbox_id, 'worker:other', 1000)).toBeUndefined();
    expect(f.database.authority.db.prepare('SELECT count(*) AS n FROM memory_outbox_attempts').get()).toEqual({ n: 1 });
    expect(f.database.authority.db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  } finally { closeMemoryDatabase(f.database); }
});
it.each(['scope', 'expired', 'request', 'fence', 'source_revoked', 'scope_review_revoked'])(
  'denies %s for a spent attempt', async mode => {
    const f = await scopedOutboxFixture();
    try {
      const registration = registerMemoryScopedOutbox(f.options, f.claimed);
      const base = { ...f.options, roots: f.dispatch.roots };
      const lease = claimMemoryScopedOutbox(base, registration.outbox_id, 'worker:fixture', 1000)!;
      const dispatched = markMemoryScopedOutboxDispatch(base, lease, 20000);
      let options = base; const request = JSON.parse(JSON.stringify(dispatched.request));
      if (mode === 'scope') options = { ...base, resolveWriteScope: () => undefined };
      if (mode === 'expired') options = { ...base, clock: () => new Date(request.expires_at) };
      if (mode === 'request') request.preparation.payload.content = 'changed';
      if (mode === 'fence') {
        expect(() => readCurrentDispatchedMemoryScopedOutbox(base, registration.outbox_id, dispatched.fence + 1)).toThrow();
        return;
      }
      if (mode.endsWith('_revoked')) {
        const reference = mode === 'scope_review_revoked' ? f.review.request_id : f.candidate.source.verification_evidence_id;
        f.database.authority.db.prepare('INSERT INTO authority_revocations(reference,reason,created_at) VALUES(?,?,?)')
          .run(reference, 'fixture revoked', f.now.toISOString());
      }
      expect(() => verifyMemoryScopedProviderWrite(options, request)).toThrow();
    } finally { closeMemoryDatabase(f.database); }
  });

it.each(['expiry', 'rewind', 'mutated_clock'])('rejects authority clock %s at final checks', async mode => {
  const f = await scopedOutboxFixture();
  try {
    const r = registerMemoryScopedOutbox(f.options, f.claimed), base = { ...f.options, roots: f.dispatch.roots };
    const lease = claimMemoryScopedOutbox(base, r.outbox_id, 'worker:fixture', 1000)!;
    const dispatch = markMemoryScopedOutboxDispatch(base, lease, 20000);
    let calls = 0;
    const options = { ...base, clock: () => new Date(f.now.getTime() + (calls >= 2 ? mode === 'rewind' ? -1 : 10 : 0)),
      resolveWriteScope: (at: Date) => {
        calls++;
        if (mode === 'mutated_clock') at.setTime(at.getTime() + 1);
        return { ...f.options.resolveWriteScope(f.now)!, valid_until: new Date(f.now.getTime() + 10).toISOString() };
      } };
    expect(() => verifyMemoryScopedProviderWrite(options, dispatch.request)).toThrow();
  } finally { closeMemoryDatabase(f.database); }
});
