import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { loadSecondBrainContract } from "../../src/second-brain-transport-contract.js";
import { inspectFrozenSchemas } from "../../src/second-brain-frozen.js";
import { createSecondBrainTransport } from "../../src/second-brain-transport.js";
const path = fileURLToPath(new URL('../../contracts/second-brain-scoped-read-v1.json', import.meta.url));
const contract = loadSecondBrainContract(path, 'scoped-record-read-v1') as { tools: Record<string, { arguments: unknown }> };
const tools = Object.entries(contract.tools).map(([name, tool]) => ({ name, inputSchema: tool.arguments }));
describe('scoped transport frozen profile', () => {
  it('requires the exact two tools and required claim schema', () => {
    expect(inspectFrozenSchemas(tools, contract).matches).toBe(true);
    expect(inspectFrozenSchemas(tools.slice(1), contract).matches).toBe(false);
    expect(inspectFrozenSchemas([...tools, { name: 'sb_remember', inputSchema: {} }], contract).matches).toBe(false);
    const changed = structuredClone(tools);
    (changed[0]!.inputSchema as { required: string[] }).required.pop();
    expect(inspectFrozenSchemas(changed, contract).matches).toBe(false);
  });
  it('does not load an old profile as the scoped contract', () => {
    expect(() => loadSecondBrainContract(path, 'task32-schema4')).toThrow('SECOND_BRAIN_CONTRACT_MISMATCH');
  });
  it('rejects unsupported methods and missing claims before starting a process', async () => {
    let started = 0;
    const transport = createSecondBrainTransport({ contractProfile: 'scoped-record-read-v1', contractPath: path,
      execFile: () => { started++; throw new Error('must not spawn'); } });
    await expect(transport.call('sb_generation_status', {})).rejects.toThrow('SECOND_BRAIN_INVALID_ARGUMENTS');
    await expect(transport.call('sb_read_page', { id: 'wiki/example' })).rejects.toThrow('SECOND_BRAIN_INVALID_ARGUMENTS');
    await expect(transport.call('sb_search', { query: 'example', read_fence: {}, access_claim: {}, extra: true })).rejects.toThrow('SECOND_BRAIN_INVALID_ARGUMENTS');
    expect(started).toBe(0);
    await transport.close();
  });
});

it('loads v2 with status while keeping v1 fixed at two methods', () => {
  const v2 = loadSecondBrainContract(path.replace('-v1.json', '-v2.json'), 'scoped-record-read-v2') as typeof contract;
  expect(Object.keys(v2.tools).sort()).toEqual(['sb_generation_status', 'sb_read_page', 'sb_search']);
  expect(inspectFrozenSchemas(tools, v2).matches).toBe(false);
  expect(() => loadSecondBrainContract(path, 'scoped-record-read-v2')).toThrow('SECOND_BRAIN_CONTRACT_MISMATCH');
});

it('pins v3 separately and refuses older contracts, writes and missing claims', async () => {
  const v3Path = path.replace('-v1.json', '-v3.json');
  const v3 = loadSecondBrainContract(v3Path, 'scoped-record-read-v3') as typeof contract & { read_page_access: unknown };
  expect(v3.read_page_access).toBeDefined();
  const declared = Object.entries(v3.tools).map(([name, tool]) => ({ name, inputSchema: tool.arguments }));
  expect(inspectFrozenSchemas(declared, v3).matches).toBe(true);
  expect(Object.keys(v3.tools).sort()).toEqual(['sb_generation_status', 'sb_read_page', 'sb_search']);
  expect(() => loadSecondBrainContract(path.replace('-v1.json', '-v2.json'), 'scoped-record-read-v3')).toThrow('SECOND_BRAIN_CONTRACT_MISMATCH');
  expect(() => loadSecondBrainContract(v3Path, 'scoped-record-read-v2')).toThrow('SECOND_BRAIN_CONTRACT_MISMATCH');
  let starts = 0;
  const transport = createSecondBrainTransport({ contractProfile: 'scoped-record-read-v3', contractPath: v3Path,
    execFile: () => { starts++; throw new Error('must not spawn'); } });
  try {
    await expect(transport.call('sb_read_page', { id: 'wiki/example' })).rejects.toThrow('SECOND_BRAIN_INVALID_ARGUMENTS');
    await expect(transport.call('sb_write_request', { request: {} })).rejects.toThrow('SECOND_BRAIN_INVALID_ARGUMENTS');
    expect(starts).toBe(0);
  } finally { await transport.close(); }
});
