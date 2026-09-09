import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterEach, expect, it } from "vitest";
import { canonicalize } from "../../src/canonical.js";
import { createMemoryScopedClient } from "../../src/memory-scoped-client.js";
import { createProductionMemoryAccessClaim } from "../../src/memory-access-claim-production.js";
import { memoryHash } from "../../src/memory-candidate-values.js";
import type { SecondBrainTransport } from "../../src/second-brain-transport.js";
import { closeMemoryDatabase, memoryDatabase, type MemoryDatabase } from "../fixtures/memory-candidate-store.js";
import { memoryReadFenceFixture } from "../fixtures/memory-read-fence.js";
import { OUTBOX_NOW } from "../fixtures/memory-outbox-fixture.js";
const load = (name: string) => JSON.parse(readFileSync(new URL(`../fixtures/${name}.json`, import.meta.url), 'utf8'));
const request = load('scoped-write-request-v4'), recorded = load('scoped-provider-proof-v4');
const artifact = load('scoped-remembered-artifact'), access = load('scoped-page-access');
const databases: MemoryDatabase[] = [];
afterEach(() => { for (const db of databases.splice(0)) closeMemoryDatabase(db); });
async function fixture(mode = 'valid') {
  const db = await memoryDatabase(); databases.push(db);
  const { config } = memoryReadFenceFixture(db);
  let calls = 0, now = OUTBOX_NOW;
  const controller = new AbortController();
  if (mode === 'cancel_before') controller.abort();
  const scope = { principal_id: 'principal:owner' as const, agent_id: 'agent:reader', session_id: 'session:reader',
    projects: ['project:shared-memory'], policy_revision: 'policy:fixture',
    valid_until: new Date(now.getTime() + 10000).toISOString() };
  const resolve = (_at: Date, input: { method: string }) => {
    if (mode === 'cancel_recheck' && calls === 3) controller.abort();
    if (input.method === 'sb_read_page' && mode === 'revoked_page' && calls >= 3) return undefined;
    return { ...scope, session_id: mode === 'session' && input.method === 'sb_read_page' ? 'session:other' : scope.session_id,
      valid_until: (mode === 'expired_page' || (mode === 'shortened_page' && calls >= 3)) && input.method === 'sb_read_page' ? new Date(OUTBOX_NOW.getTime() + 500).toISOString() : scope.valid_until };
  };
  const transport: SecondBrainTransport = {
    async call(method, args, options) {
      options?.beforeSend?.(); calls++;
      const claim = args.access_claim as Record<string, unknown>, fence = args.read_fence as Record<string, unknown>;
      const status: Record<string, any> = { schema_version: 4, provider_instance_id: request.provider_instance_id,
        request_id: request.request_id, request_digest: request.request_digest, scope_digest: recorded.accepted.scope_digest,
        state: 'proved', phase: 'proved', updated_at: recorded.receipt.updated_at, proof: structuredClone(recorded.proof),
        receipt: structuredClone(recorded.receipt), acceptance: { ...recorded.accepted, replayed: true } };
      if (mode === 'pending' || (mode === 'changed_status' && calls === 3)) {
        status.state = 'pending'; status.phase = null; delete status.proof; delete status.receipt;
      }
      if (mode === 'proof_changed' && calls === 3) {
        status.proof.head = 'b'.repeat(40);
        status.receipt.proof_digest = memoryHash('second-brain/memory-surface-manifest/v1\0', status.proof);
        status.receipt.status_digest = memoryHash('second-brain/memory-surface-manifest/v1\0', { state: 'proved', proof: status.receipt.proof_digest });
      }
      const generation = { provider_instance_id: artifact.provider_instance_id, generation_id: artifact.generation_id,
        generation_manifest_digest: artifact.generation_manifest_digest, vault_head: artifact.vault_head, vault_tree: artifact.vault_tree };
      if ((mode === 'generation' && calls === 3) || (mode === 'advance_before_page' && calls >= 2)) {
        generation.generation_id = 'sbgen:v1:' + 'a'.repeat(64); generation.generation_manifest_digest = 'sha256:' + 'a'.repeat(64);
      }
      if (mode === 'expired_page' && calls === 3) now = new Date(OUTBOX_NOW.getTime() + 1000);
      const payload = method === 'sb_read_page'
        ? { page_id: artifact.page_id, content_digest: artifact.content_digest,
            records: mode === 'missing' ? [] : artifact.records, page_access: access }
        : { request_status: status };
      if (mode === 'cancel_after_' + calls) controller.abort();
      return { kind: 'data', value: { ...generation, ...payload, profile: 'scoped-record-read-v5', request_digest: claim.request_digest,
        access_claim_digest: 'sha256:' + createHash('sha256').update('orca-jarvis/memory-access-claim-binding/v1\0' + canonicalize(claim)).digest('hex'),
        tombstone_sequence: fence.tombstone_sequence, tombstone_set_root: fence.tombstone_set_root } };
    }, async close() {}, async restart() {}, diagnostics: () => [],
  };
  const client = createMemoryScopedClient({ profile: 'scoped-record-read-v5', transport,
    issue: createProductionMemoryAccessClaim(db.authority, config, resolve),
    status_issue: createProductionMemoryAccessClaim(db.authority, config, resolve, 'memory_status'), now: () => now,
    budgets: { max_hits: 10, max_excerpt_bytes: 4096, max_total_bytes: 100000, max_page_bytes: 20000 }, max_age_ms: 86400000, expiry_ms: 172800000 });
  return { client, calls: () => calls, signal: controller.signal };
}
it.each(['valid', 'advance_before_page', 'shortened_page'])('combines durable completion and exact current artifact: %s', async mode => {
  const f = await fixture(mode);
  const result = await f.client.readRememberedCompletion(request);
  expect(result.kind).toBe('remembered_completion_observed');
  expect(result.artifact.record_ids.length).toBe(4);
  expect(result.status.state).toBe('proved');
  expect(f.calls()).toBe(3);
  expect(Object.isFrozen(result)).toBe(true);
  expect(Object.isFrozen(result.artifact)).toBe(true);
  expect(Date.parse(result.checked_at)).toBeLessThan(Date.parse(result.valid_until));
  if (mode === 'shortened_page') expect(Date.parse(result.valid_until)).toBe(OUTBOX_NOW.getTime() + 500);
  if (mode === 'advance_before_page') expect(result.artifact.generation.generation_id).toBe('sbgen:v1:' + 'a'.repeat(64));
});
it.each(['pending', 'missing', 'generation', 'changed_status', 'proof_changed', 'session', 'revoked_page', 'expired_page'])(
  'withholds completion after %s', async mode => {
    const f = await fixture(mode);
    await expect(f.client.readRememberedCompletion(request)).rejects.toThrow();
    if (mode === 'pending') expect(f.calls()).toBe(1);
  });

it.each(['cancel_before', 'cancel_after_1', 'cancel_after_2', 'cancel_after_3', 'cancel_recheck'])(
  'does not return completion after cancellation: %s', async mode => {
    const f = await fixture(mode);
    await expect(f.client.readRememberedCompletion(request, f.signal)).rejects.toMatchObject({ code: 'SECOND_BRAIN_CANCELLED' });
    expect(f.calls()).toBe(mode === 'cancel_before' ? 0 : mode === 'cancel_recheck' ? 3 : Number(mode.slice(-1)));
  });
