import { writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createProductionScopedMemory } from "../../src/memory-scoped-production.js";
import { closeMemoryDatabase, memoryDatabase, type MemoryDatabase } from "../fixtures/memory-candidate-store.js";
import { memoryReadFenceFixture } from "../fixtures/memory-read-fence.js";
import { OUTBOX_NOW } from "../fixtures/memory-outbox-fixture.js";
import { execute } from "../../src/cli-runtime.mjs";
const databases: MemoryDatabase[] = [];
afterEach(() => { for (const db of databases.splice(0)) closeMemoryDatabase(db); });
it('requires existing keys and a current explicit session grant without creating either', async () => {
  const db = await memoryDatabase(); databases.push(db);
  const { config } = memoryReadFenceFixture(db);
  const policy = join(db.root, 'policy.json'); const key = join(db.root, 'projection.key');
  const session = { principal_id: 'principal:owner' as const, agent_id: 'agent:test', session_id: 'session:test',
    expires_at: new Date(OUTBOX_NOW.getTime() + 10000).toISOString() };
  let active = true; let starts = 0;
  const options = { policy_path: policy, projection_key_path: key, read_fence_config: config,
    authenticated_session: () => active ? session : undefined, clock: () => OUTBOX_NOW,
    transport_options: { execFile: () => { starts++; throw new Error('unexpected process'); } } };
  expect(() => createProductionScopedMemory(db.authority, options)).toThrow('MEMORY_REFERENCE_KEY_UNAVAILABLE');
  expect(existsSync(key)).toBe(false); expect(existsSync(policy)).toBe(false);
  writeFileSync(key, Buffer.alloc(32, 7), { mode: 0o600 });
  expect(() => createProductionScopedMemory(db.authority, options)).toThrow('MEMORY_ACCESS_SCOPE_UNAVAILABLE');
  const grant = { schema_version: 1, provider_instance_id: config.provider_instance_id, principal_id: session.principal_id,
    policy_revision: 'policy:1', valid_from: OUTBOX_NOW.toISOString(), valid_until: session.expires_at,
    sessions: [{ agent_id: session.agent_id, session_id: session.session_id, projects: ['project:a'],
      methods: ['sb_generation_status', 'sb_read_page', 'sb_search'] }] };
  writeFileSync(policy, JSON.stringify(grant), { mode: 0o600 });
  active = false; expect(() => createProductionScopedMemory(db.authority, options)).toThrow('MEMORY_ACCESS_SCOPE_UNAVAILABLE');
  await expect(execute(['memory', 'context', 'example', '--db', db.path], {
    clock: () => OUTBOX_NOW, scopedMemoryReferenceOptions: options,
  })).rejects.toMatchObject({ code: 'MEMORY_ACCESS_SCOPE_UNAVAILABLE' });
  await expect(execute(['memory', 'context', 'example', '--db', db.path], {
    clock: () => OUTBOX_NOW, scopedMemoryReferenceOptions: options, memoryReferenceOptions: {},
  })).rejects.toMatchObject({ code: 'MEMORY_REFERENCE_CONFIG_AMBIGUOUS' });
  expect(starts).toBe(0);
  active = true;
  const runtime = createProductionScopedMemory(db.authority, options);
  expect(runtime.reader).toBeDefined(); expect(starts).toBe(0);
  expect(readFileSync(key)).toEqual(Buffer.alloc(32, 7));
  await runtime.close(); await runtime.close();
  expect(starts).toBe(0);
});
