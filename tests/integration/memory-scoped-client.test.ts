import { createHash } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import { canonicalize } from "../../src/canonical.js";
import { createScopedMemoryReference } from "../../src/memory-scoped-reference.js";
import { createMemoryMembership } from "../../src/memory-membership.js";
import { createMemoryScopedClient } from "../../src/memory-scoped-client.js";
import { createProductionMemoryAccessClaim, type AuthorizedMemoryReadScope } from "../../src/memory-access-claim-production.js";
import { revokeMemoryEffectDelegationKey } from "../../src/memory-effect-delegation.js";
import type { SecondBrainTransport } from "../../src/second-brain-transport.js";
import { closeMemoryDatabase, memoryDatabase, type MemoryDatabase } from "../fixtures/memory-candidate-store.js";
import { memoryReadFenceFixture } from "../fixtures/memory-read-fence.js";
import { OUTBOX_NOW } from "../fixtures/memory-outbox-fixture.js";
const databases: MemoryDatabase[] = [];
afterEach(() => { for (const db of databases.splice(0)) closeMemoryDatabase(db); });
it("rechecks real issuer authority before send and delivery without inventing empty evidence", async () => {
  const db = await memoryDatabase(); databases.push(db);
  const { config } = memoryReadFenceFixture(db);
  const scope: AuthorizedMemoryReadScope = { principal_id: 'principal:owner', agent_id: 'agent:test', session_id: 'session:test',
    projects: ['project:a'], policy_revision: 'policy:1', valid_until: new Date(OUTBOX_NOW.getTime() + 10000).toISOString() };
  let current: AuthorizedMemoryReadScope | undefined = scope;
  let clock = OUTBOX_NOW;
  let before = () => {};
  let after = () => {};
  let sent = 0;
  let searchGeneration = "1".repeat(64);
  const transport: SecondBrainTransport = {
    async call(_method, args, options) {
      before(); options?.beforeSend?.(); sent++;
      const claim = args.access_claim as Record<string, unknown>;
      const fence = args.read_fence as Record<string, unknown>;
      const value = { profile: 'scoped-record-read-v2', request_digest: claim.request_digest,
        access_claim_digest: 'sha256:' + createHash('sha256').update('orca-jarvis/memory-access-claim-binding/v1\0' + canonicalize(claim)).digest('hex'),
        provider_instance_id: config.provider_instance_id, generation_id: 'sbgen:v1:' + (_method === 'sb_search' ? searchGeneration : '1'.repeat(64)),
        generation_manifest_digest: 'sha256:' + '2'.repeat(64), vault_head: '3'.repeat(40), vault_tree: '4'.repeat(40),
        tombstone_sequence: fence.tombstone_sequence, tombstone_set_root: fence.tombstone_set_root,
        ...(_method === "sb_generation_status" ? { schema_version: 1, pointer_health: "healthy", journal_health: "healthy" } : { results: [] }) };
      after(); return { kind: 'data', value };
    }, async close() {}, async restart() {}, diagnostics: () => [],
  };
  const client = createMemoryScopedClient({ profile: "scoped-record-read-v2",
    status_issue: createProductionMemoryAccessClaim(db.authority, config, () => current, "memory_status"), issue: createProductionMemoryAccessClaim(db.authority, config, () => current), transport,
    now: () => clock, budgets: { max_hits: 10, max_excerpt_bytes: 4096, max_total_bytes: 100000, max_page_bytes: 20000 },
    max_age_ms: 86400000, expiry_ms: 172800000 });
  expect((await client.search('example')).pages).toEqual([]);
  const reader = createScopedMemoryReference(db.authority, { client, clock: () => clock,
    membership: createMemoryMembership(Buffer.alloc(32, 7)), search_limit: 10 });
  searchGeneration = '2'.repeat(64);
  await expect(reader.read('example', { max_records: 8, max_record_bytes: 4096, max_bytes: 16384 })).rejects.toThrow('MEMORY_REFERENCE_GENERATION_CHANGED');
  searchGeneration = '1'.repeat(64);
  const reference = await reader.read('example', { max_records: 8, max_record_bytes: 4096, max_bytes: 16384 });
  expect(reference.payload.state).toBe('empty');
  let callbacks = 0;
  await reader.submit(reference, async payload => { callbacks++; expect(payload).toBe(reference.serialized); });
  await expect(reader.submit(reference, async () => { callbacks++; })).rejects.toThrow('MEMORY_REFERENCE_SUBMISSION_INVALID');
  expect(callbacks).toBe(1);
  const pendingReference = await reader.read('example', { max_records: 8, max_record_bytes: 4096, max_bytes: 16384 });
  current = { ...scope, session_id: 'session:other' };
  await expect(reader.submit(pendingReference, async () => { callbacks++; })).rejects.toThrow('MEMORY_REFERENCE_SCOPE_CHANGED');
  expect(callbacks).toBe(1);
  current = scope;
  const sentBeforeRevocation = sent;
  before = () => { current = undefined; };
  await expect(client.search('example')).rejects.toThrow('MEMORY_ACCESS_SCOPE_UNAVAILABLE');
  expect(sent).toBe(sentBeforeRevocation);
  before = () => {}; current = scope;
  after = () => { current = { ...scope, session_id: 'session:changed' }; };
  await expect(client.search('example')).rejects.toThrow('MEMORY_SCOPED_READ_UNAVAILABLE');
  current = scope; after = () => { current = { ...scope, projects: ['project:b'] }; };
  await expect(client.search('example')).rejects.toThrow('MEMORY_SCOPED_READ_UNAVAILABLE');
  current = scope; after = () => { clock = new Date(scope.valid_until); };
  await expect(client.search('example')).rejects.toThrow('MEMORY_SCOPED_READ_UNAVAILABLE');
  clock = OUTBOX_NOW; after = () => { revokeMemoryEffectDelegationKey(db.authority, config.signing_key_id); };
  await expect(client.search('example')).rejects.toThrow('MEMORY_READ_FENCE_KEY_UNAVAILABLE');
});
