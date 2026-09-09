import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { parseSecondBrainRecoveredRequestStatus, parseSecondBrainScopedRequestStatus } from "../../src/second-brain-scoped-request-status.js";
import { memoryHash } from "../../src/memory-candidate-values.js";
const request = JSON.parse(readFileSync('tests/fixtures/scoped-write-request-v4.json', 'utf8'));
const fixture = JSON.parse(readFileSync('tests/fixtures/scoped-provider-proof-v4.json', 'utf8'));
function value() {
  return { schema_version: 4, provider_instance_id: request.provider_instance_id,
    request_id: request.request_id, request_digest: request.request_digest,
    scope_digest: fixture.accepted.scope_digest, state: 'proved', phase: 'proved',
    updated_at: fixture.receipt.updated_at, proof: structuredClone(fixture.proof), receipt: structuredClone(fixture.receipt) };
}
const at = new Date('2026-09-01T00:00:00.000Z');
it('validates a detached historical completion after write expiry', () => {
  const original = value();
  const result = parseSecondBrainScopedRequestStatus(original, request, fixture.accepted, at);
  expect(result.state).toBe('proved');
  expect(Object.isFrozen(result)).toBe(true);
  original.proof.head = '0'.repeat(40);
  expect((result as Record<string, any>).proof.head).toBe(fixture.proof.head);
});
it.each(['scope', 'request', 'provider', 'content', 'digest', 'receipt', 'time', 'extra', 'phase', 'state'])(
  'rejects mismatched %s', mode => {
    const status: Record<string, any> = value();
    if (mode === 'scope') status.scope_digest = 'sha256:' + '0'.repeat(64);
    if (mode === 'request') status.request_id = 'wrong';
    if (mode === 'provider') status.provider_instance_id = 'provider:other';
    if (mode === 'content') {
      status.proof.content_digest = 'sha256:' + '0'.repeat(64);
      status.receipt.proof_digest = memoryHash('second-brain/memory-surface-manifest/v1\0', status.proof);
      status.receipt.status_digest = memoryHash('second-brain/memory-surface-manifest/v1\0', { state: 'proved', proof: status.receipt.proof_digest });
    }
    if (mode === 'digest') status.receipt.proof_digest = 'sha256:' + '0'.repeat(64);
    if (mode === 'receipt') status.receipt.request_id = 'wrong';
    if (mode === 'time') status.updated_at = '2027-01-01T00:00:00.000Z';
    if (mode === 'extra') status.extra = true;
    if (mode === 'phase') status.phase = 'staging';
    if (mode === 'state') status.state = 'pending';
    expect(() => parseSecondBrainScopedRequestStatus(status, request, fixture.accepted, at)).toThrow();
  });

it('recovers the original acceptance with no local acknowledgement and rejects substitutions', () => {
  const input = { ...value(), acceptance: { ...fixture.accepted, replayed: true } };
  const result = parseSecondBrainRecoveredRequestStatus(input, request, at);
  expect(result.acceptance).toEqual(input.acceptance);
  expect(Object.isFrozen(result.acceptance)).toBe(true);
  expect(() => parseSecondBrainRecoveredRequestStatus(value(), request, at)).toThrow();
  expect(() => parseSecondBrainRecoveredRequestStatus({ ...input, acceptance: fixture.accepted }, request, at)).toThrow();
  expect(() => parseSecondBrainRecoveredRequestStatus({ ...input, acceptance: { ...input.acceptance, request_file_digest: 'sha256:' + '0'.repeat(64) } }, request, at)).toThrow();
  expect(() => parseSecondBrainScopedRequestStatus(input, request, fixture.accepted, at)).toThrow();
});
it('returns not_found as metadata without fabricating acceptance or permitting resend', () => {
  const full = value();
  const base = { schema_version: full.schema_version, provider_instance_id: full.provider_instance_id,
    request_id: full.request_id, request_digest: full.request_digest, scope_digest: full.scope_digest };
  const result = parseSecondBrainRecoveredRequestStatus({ ...base, state: 'not_found' }, request, at);
  expect(result.state).toBe('not_found'); expect(result.acceptance).toBeUndefined();
  expect(() => parseSecondBrainRecoveredRequestStatus({ ...base, state: 'not_found', acceptance: fixture.accepted }, request, at)).toThrow();
});
