import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { inspectFrozenSchemas } from "../../src/second-brain-frozen.js";
import { loadSecondBrainContract } from "../../src/second-brain-transport-contract.js";
import { createSecondBrainTransport } from "../../src/second-brain-transport.js";
const path = fileURLToPath(new URL('../../contracts/second-brain-scoped-status-v1.json', import.meta.url));
it('pins journal-only profile and rejects unsupported tools before spawning', async () => {
  const contract = loadSecondBrainContract(path, 'scoped-request-status-v1') as { tools: Record<string, { arguments: Record<string, unknown> }> };
  expect(Object.keys(contract.tools)).toEqual(['sb_request_status']);
  const actual = { name: 'sb_request_status', description: 'Journal metadata', inputSchema: { ...contract.tools.sb_request_status!.arguments, title: 'request_statusArguments' }, outputSchema: { additionalProperties: true, type: 'object' } };
  expect(inspectFrozenSchemas([actual], contract).matches).toBe(true);
  expect(inspectFrozenSchemas([{ ...actual, inputSchema: { ...actual.inputSchema, required: ['request'] } }], contract).matches).toBe(false);
  expect(() => loadSecondBrainContract(path, 'scoped-record-read-v5')).toThrow();
  let starts = 0;
  const t = createSecondBrainTransport({ contractPath: path, contractProfile: 'scoped-request-status-v1', execFile: () => { starts++; throw Error('unexpected'); } });
  try {
    await expect(t.call('sb_write_request', {})).rejects.toThrow();
    await expect(t.call('sb_generation_status', {})).rejects.toThrow();
    await expect(t.call('sb_request_status', { request: {}, read_fence: {}, access_claim: {}, extra: true })).rejects.toThrow();
    expect(starts).toBe(0);
  } finally { await t.close(); }
});
