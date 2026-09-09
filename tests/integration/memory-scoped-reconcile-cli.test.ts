import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { execute } from "../../src/cli.js";
import { canonicalize } from "../../src/canonical.js";
import { createProductionScopedReconciler } from "../../src/memory-scoped-reconcile-production.js";
import { releaseMemoryScopedReconciliation } from "../../src/memory-scoped-reconciliation.js";
import type { SecondBrainTransport } from "../../src/second-brain-transport.js";
import { completionObservationFixture } from "../fixtures/scoped-completion-observation.js";
import { closeMemoryDatabase } from "../fixtures/memory-candidate-store.js";
import { memoryReadFenceFixture } from "../fixtures/memory-read-fence.js";

it.each(['valid', 'missing_config', 'no_session', 'other_project', 'cli_session', 'no_once'])(
  'CLI scoped reconciliation requires explicit authority: %s', async mode => {
  const f = await completionObservationFixture();
  try {
    releaseMemoryScopedReconciliation(f.database.authority, f.leased.lease, f.at);
    const now = new Date('2026-08-31T03:30:00.000Z'), until = '2026-08-31T03:40:00.000Z';
    const request = f.dispatch.request, scope = request.preparation.binding.identity;
    const { config } = memoryReadFenceFixture(f.database);
    const policyPath = join(f.database.root, 'reconcile-policy.json');
    writeFileSync(policyPath, JSON.stringify({ schema_version: 3, provider_instance_id: 'provider:fixture', principal_id: 'principal:owner',
      policy_revision: scope.policy_revision, valid_from: now.toISOString(), valid_until: until,
      agents: [{ agent_id: 'agent:reader', projects: mode === 'other_project' ? ['project:other'] : scope.projects,
        methods: ['sb_generation_status', 'sb_read_page', 'sb_request_status'] }] }), { mode: 0o600 });
    let calls = 0, closes = 0;
    const transport: SecondBrainTransport = {
      async call(method, args, opt) {
        expect(method).toBe('sb_request_status'); opt?.beforeSend?.(); calls++;
        const c = args.access_claim as Record<string, unknown>, fence = args.read_fence as Record<string, unknown>;
        const { proof: _proof, receipt: _receipt, ...status } = f.observation.status;
        void _proof; void _receipt;
        return { kind: 'data', value: { profile: 'scoped-request-status-v1', request_digest: c.request_digest,
          access_claim_digest: 'sha256:' + createHash('sha256').update('orca-jarvis/memory-access-claim-binding/v1\0' + canonicalize(c)).digest('hex'),
          provider_instance_id: 'provider:fixture', tombstone_sequence: fence.tombstone_sequence, tombstone_set_root: fence.tombstone_set_root,
          request_status: { ...status, state: 'pending', phase: null } } };
      }, async close() { closes++; }, async restart() {}, diagnostics: () => [],
    };
    const options = { policy_path: policyPath, read_fence_config: config, spool_root: f.options.spoolRoot,
      roots: { candidate_dispatch_spool_root: f.options.dispatch.roots.dispatch, candidate_review_spool_root: f.options.dispatch.roots.review },
      authenticated_session: () => mode === 'no_session' ? undefined : { principal_id: 'principal:owner' as const,
        agent_id: 'agent:reader', session_id: 'session:reader', expires_at: until },
      journal_transport: transport, completion_transport: transport, clock: () => now };
    const args = ['memory', 'reconcile-scoped', f.dispatch.outbox_id, '--db', f.database.path,
      ...(mode === 'no_once' ? [] : ['--once']), ...(mode === 'cli_session' ? ['--session_id', 'session:forged'] : [])];
    const before = f.database.authority.db.prepare('SELECT lease_fence FROM memory_outbox').get();
    if (mode === 'valid') {
      const result = await execute(args, { clock: () => now, scopedMemoryReconcileOptions: options });
      expect(result.ok).toBe(true); expect((result.result as any).kind).toBe('scoped_reconciliation_deferred');
      expect(calls).toBe(1); expect(closes).toBe(0);
      const runtime = createProductionScopedReconciler(f.database.authority, options);
      await runtime.close(); await runtime.close();
      await expect(runtime.runOnce(f.dispatch.outbox_id, 'worker:test')).rejects.toThrow('MEMORY_SCOPED_RECONCILE_CLOSED');
    } else {
      await expect(execute(args, { clock: () => now, ...(mode === 'missing_config' ? {} : { scopedMemoryReconcileOptions: options }) })).rejects.toThrow();
      expect(calls).toBe(0); expect(f.database.authority.db.prepare('SELECT lease_fence FROM memory_outbox').get()).toEqual(before);
    }
    expect(f.database.authority.db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  } finally { closeMemoryDatabase(f.database); }
});
