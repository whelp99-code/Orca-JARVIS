import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterEach, expect, it } from "vitest";
import { canonicalize } from "../../src/canonical.js";
import { createMemoryScopedClient } from "../../src/memory-scoped-client.js";
import { createProductionMemoryAccessClaim, type AuthorizedMemoryReadScope } from "../../src/memory-access-claim-production.js";
import type { SecondBrainTransport } from "../../src/second-brain-transport.js";
import { closeMemoryDatabase, memoryDatabase, type MemoryDatabase } from "../fixtures/memory-candidate-store.js";
import { memoryReadFenceFixture } from "../fixtures/memory-read-fence.js";
import { OUTBOX_NOW } from "../fixtures/memory-outbox-fixture.js";
const request = JSON.parse(readFileSync(new URL('../fixtures/scoped-write-request-v4.json', import.meta.url), 'utf8'));
const accepted = JSON.parse(readFileSync(new URL('../fixtures/scoped-provider-proof-v4.json', import.meta.url), 'utf8')).accepted;
const artifact = JSON.parse(readFileSync(new URL('../fixtures/scoped-remembered-artifact.json', import.meta.url), 'utf8'));
const databases: MemoryDatabase[] = [];
afterEach(() => { for (const db of databases.splice(0)) closeMemoryDatabase(db); });
async function setup() {
  const db = await memoryDatabase(); databases.push(db);
  const { config } = memoryReadFenceFixture(db);
  const scope: AuthorizedMemoryReadScope = { principal_id: 'principal:owner', agent_id: 'agent:reader', session_id: 'session:reader',
    projects: ['project:shared-memory'], policy_revision: 'policy:fixture', valid_until: new Date(OUTBOX_NOW.getTime() + 10000).toISOString() };
  const state = { current: scope as AuthorizedMemoryReadScope | undefined, value: structuredClone(artifact),
    after: () => {}, sent: 0, error: false, mutate: () => {} };
  const transport: SecondBrainTransport = {
    async call(method, args, options) {
      options?.beforeSend?.(); state.sent++;
      expect(method).toBe('sb_read_page'); expect(args.id).toBe(artifact.page_id);
      const claim = args.access_claim as Record<string, unknown>;
      const fence = args.read_fence as Record<string, unknown>;
      state.mutate(); state.after();
      if (state.error) return { kind: 'error', code: 'FIXTURE_TOOL_FAILURE' };
      return { kind: 'data', value: { ...state.value, profile: 'scoped-record-read-v2', request_digest: claim.request_digest,
        access_claim_digest: 'sha256:' + createHash('sha256').update('orca-jarvis/memory-access-claim-binding/v1\0' + canonicalize(claim)).digest('hex'),
        tombstone_sequence: fence.tombstone_sequence, tombstone_set_root: fence.tombstone_set_root } };
    }, async close() {}, async restart() {}, diagnostics: () => [],
  };
  const client = createMemoryScopedClient({ profile: 'scoped-record-read-v2',
    issue: createProductionMemoryAccessClaim(db.authority, config, () => state.current), transport, now: () => OUTBOX_NOW,
    budgets: { max_hits: 10, max_excerpt_bytes: 4096, max_total_bytes: 100000, max_page_bytes: 20000 },
    max_age_ms: 86400000, expiry_ms: 172800000 });
  return { state, client, scope };
}
it('reads actual Python records after write expiry, retaining ordered duplicate lines and origin', async () => {
  const { client, state } = await setup();
  const result = await client.readRememberedArtifact(request, accepted);
  expect(result.kind).toBe('remembered_content_observed');
  expect(result.record_ids).toHaveLength(4);
  expect(result.request_id).toBe(request.request_id);
  expect(state.sent).toBe(1);
  expect(Object.isFrozen(result.record_ids)).toBe(true);
  expect(JSON.stringify(result)).not.toContain('첫 결정');
});
it('accepts the artifact in a later independently bound generation', async () => {
  const { client, state } = await setup();
  state.value.generation_id = 'sbgen:v1:' + 'a'.repeat(64);
  state.value.generation_manifest_digest = 'sha256:' + 'a'.repeat(64);
  expect((await client.readRememberedArtifact(request, accepted)).generation.generation_id).toBe(state.value.generation_id);
});
it.each(['project', 'policy', 'revocation', 'missing', 'origin', 'content', 'generation', 'tool_error', 'reordered_spans'])(
  'rejects %s without producing remembered evidence', async mode => {
    const { client, state, scope } = await setup();
    if (mode === 'project') state.current = { ...scope, projects: ['project:other'] };
    if (mode === 'policy') state.current = { ...scope, policy_revision: 'policy:next' };
    if (mode === 'revocation') state.after = () => { state.current = undefined; };
    if (mode === 'missing') state.value.records = [];
    if (mode === 'generation') state.value.generation_manifest_digest = 'sha256:' + 'c'.repeat(64);
    if (mode === 'tool_error') state.error = true;
    if (['origin', 'content', 'reordered_spans'].includes(mode)) {
      const row = state.value.records[0];
      if (mode === 'origin') row.source_identity_full = 'b'.repeat(64);
      if (mode === 'content') { row.record_text = '다른 문장'; row.content_identity_full = createHash('sha256').update(row.record_text).digest('hex'); row.record_text_digest = 'sha256:' + row.content_identity_full; }
      if (mode === 'reordered_spans') { row.citation_span_start = 9999; row.citation_span_end = 10000; }
      const core = { ...row }; delete core.record_id; delete core.record_digest;
      row.record_digest = 'sha256:' + createHash('sha256').update('second-brain/memory-record/v1\0' + canonicalize(core)).digest('hex');
      row.record_id = 'sbrecord:v1:' + row.record_digest.slice(7);
    }
    await expect(client.readRememberedArtifact(request, accepted)).rejects.toThrow();
    if (['project', 'policy'].includes(mode)) expect(state.sent).toBe(0);
  });
it('snapshots request material before transport callbacks can mutate it', async () => {
  const { client, state } = await setup();
  const mutable = structuredClone(request);
  state.mutate = () => { mutable.preparation.payload.content = '변경'; };
  expect((await client.readRememberedArtifact(mutable, accepted)).record_ids).toHaveLength(4);
});

it('allows a reader whose authenticated project grant contains the request scope', async () => {
  const { client, state, scope } = await setup();
  state.current = { ...scope, projects: ['project:other', 'project:shared-memory'] };
  expect((await client.readRememberedArtifact(request, accepted)).record_ids).toHaveLength(4);
});
