import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { snapshotMemoryScopedWriteArguments } from "../../src/memory-scoped-write-codec.js";
import { loadSecondBrainContract } from "../../src/second-brain-transport-contract.js";
import { createSecondBrainTransport } from "../../src/second-brain-transport.js";
import { inspectFrozenSchemas } from "../../src/second-brain-frozen.js";
const path = fileURLToPath(new URL('../../contracts/second-brain-scoped-write-v1.json', import.meta.url));
const raw = JSON.parse(readFileSync(new URL('../fixtures/scoped-write-request-v4.json', import.meta.url), 'utf8'));

it('pins one write method and cannot confuse the read or legacy profile', async () => {
  const contract = loadSecondBrainContract(path, 'scoped-request-write-v1') as { tools: Record<string, { arguments: unknown }> };
  const tools = Object.entries(contract.tools).map(([name, tool]) => ({ name, inputSchema: tool.arguments }));
  expect(tools.map(tool => tool.name)).toEqual(['sb_write_request']);
  expect(inspectFrozenSchemas(tools, contract).matches).toBe(true);
  expect(inspectFrozenSchemas([...tools, { name: 'sb_search', inputSchema: {} }], contract).matches).toBe(false);
  expect(() => loadSecondBrainContract(path, 'scoped-record-read-v5')).toThrow();
  let started = 0;
  const transport = createSecondBrainTransport({ contractProfile: 'scoped-request-write-v1', contractPath: path,
    execFile: () => { started++; throw new Error('must not spawn'); } });
  try {
    await expect(transport.call('sb_search', {})).rejects.toThrow('SECOND_BRAIN_INVALID_ARGUMENTS');
    await expect(transport.call('sb_write_request', { request: raw, extra: true })).rejects.toThrow('SECOND_BRAIN_INVALID_ARGUMENTS');
    await expect(transport.call('sb_write_request', { request: { ...raw, schema_version: 3 } })).rejects.toThrow('SECOND_BRAIN_INVALID_ARGUMENTS');
    expect(started).toBe(0);
  } finally { await transport.close(); }
});

it('snapshots the exact validated scoped request without retaining caller mutation', () => {
  const input = structuredClone(raw);
  const snapshot = snapshotMemoryScopedWriteArguments({ request: input });
  expect(snapshot?.request).toEqual(raw);
  input.writer.session_id = 'session:changed';
  expect(snapshot?.request).toEqual(raw);
  expect(Object.isFrozen(snapshot?.request)).toBe(true);
  expect(snapshotMemoryScopedWriteArguments({ request: input })).toBeUndefined();
});
