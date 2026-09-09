import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterEach, expect, it } from "vitest";
import { canonicalize } from "../../src/canonical.js";
import { createMemoryScopedJournalClient } from "../../src/memory-scoped-journal-client.js";
import { createProductionMemoryAccessClaim, type AuthorizedMemoryReadScope } from "../../src/memory-access-claim-production.js";
import { parseMemoryScopedWriteRequestJson } from "../../src/memory-scoped-write-codec.js";
import type { SecondBrainTransport } from "../../src/second-brain-transport.js";
import { closeMemoryDatabase, memoryDatabase, type MemoryDatabase } from "../fixtures/memory-candidate-store.js";
import { memoryReadFenceFixture } from "../fixtures/memory-read-fence.js";
const databases: MemoryDatabase[] = [];
afterEach(() => { for (const db of databases.splice(0)) closeMemoryDatabase(db); });
const raw = readFileSync(new URL('../fixtures/scoped-write-request-v4.json', import.meta.url), 'utf8');
const request = parseMemoryScopedWriteRequestJson(canonicalize(JSON.parse(raw)), 'provider:fixture', new Date(JSON.parse(raw).created_at));

it.each(['normal', 'before_revoke', 'after_revoke', 'session', 'expired', 'rewind', 'cancel', 'digest', 'fence', 'generation', 'profile', 'oversize'])('journal observation enforces %s', async mode => {
  const db = await memoryDatabase(); databases.push(db);
  const { config } = memoryReadFenceFixture(db);
  let clock = new Date('2026-08-31T03:30:00.000Z');
  let scope: AuthorizedMemoryReadScope | undefined = { principal_id: 'principal:owner', agent_id: 'agent:reader', session_id: 'session:reader',
    projects: request.preparation.binding.identity.projects, policy_revision: request.preparation.binding.identity.policy_revision,
    valid_until: '2026-08-31T03:31:00.000Z' };
  const controller = new AbortController(); let sends = 0;
  const transport: SecondBrainTransport = {
    async call(method, args, options) {
      expect(method).toBe('sb_request_status');
      if (mode === 'before_revoke') scope = undefined;
      options?.beforeSend?.(); sends++;
      const claim = args.access_claim as Record<string, unknown>, fence = args.read_fence as Record<string, unknown>;
      const value: Record<string, unknown> = { profile: 'scoped-request-status-v1', request_digest: claim.request_digest,
        access_claim_digest: 'sha256:' + createHash('sha256').update('orca-jarvis/memory-access-claim-binding/v1\0' + canonicalize(claim)).digest('hex'),
        provider_instance_id: 'provider:fixture', tombstone_sequence: fence.tombstone_sequence, tombstone_set_root: fence.tombstone_set_root,
        request_status: { schema_version: 4, provider_instance_id: request.provider_instance_id, request_id: request.request_id,
          request_digest: request.request_digest, scope_digest: request.preparation.binding.identity_digest, state: 'not_found' } };
      if (mode === 'after_revoke') scope = undefined;
      if (mode === 'session') scope = { ...scope!, session_id: 'session:new' };
      if (mode === 'expired') clock = new Date('2026-08-31T03:31:00.000Z');
      if (mode === 'rewind') clock = new Date(clock.getTime() - 1);
      if (mode === 'cancel') controller.abort();
      if (mode === 'digest') value.access_claim_digest = 'sha256:' + '0'.repeat(64);
      if (mode === 'fence') value.tombstone_sequence = 1;
      if (mode === 'generation') value.generation_id = 'sbgen:v1:' + '0'.repeat(64);
      if (mode === 'profile') value.profile = 'scoped-record-read-v5';
      if (mode === 'oversize') value.request_digest = 'x'.repeat(100001);
      return { kind: 'data', value };
    }, async close() {}, async restart() {}, diagnostics: () => [],
  };
  const client = createMemoryScopedJournalClient({ issue: createProductionMemoryAccessClaim(db.authority, config, () => scope, 'memory_status'),
    transport, now: () => clock, budgets: { max_hits: 1, max_excerpt_bytes: 4096, max_total_bytes: 100000, max_page_bytes: 20000 } });
  if (mode === 'normal') {
    const result = await client.recoverRequestStatus(request, controller.signal);
    expect(result.kind).toBe('scoped_journal_status_observed'); expect(result.status.state).toBe('not_found');
    expect(Object.keys(result)).toEqual(['kind', 'status']); expect(Object.isFrozen(result.status)).toBe(true);
  } else await expect(client.recoverRequestStatus(request, controller.signal)).rejects.toThrow();
  expect(sends).toBe(mode === 'before_revoke' ? 0 : 1);
});
