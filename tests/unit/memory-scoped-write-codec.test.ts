import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { canonicalize } from "../../src/canonical.js";
import { memoryHash } from "../../src/memory-candidate-values.js";
import { parseMemoryScopedWriteRequestJson } from "../../src/memory-scoped-write-codec.js";

const fixture = JSON.parse(readFileSync(new URL("../fixtures/scoped-write-request-v4.json", import.meta.url), "utf8"));
const now = new Date(fixture.created_at);
const parse = (value: unknown) => parseMemoryScopedWriteRequestJson(canonicalize(value), "provider:fixture", now);
function reseal(value: any) {
  const base = { ...value }; delete base.request_id; delete base.request_digest;
  value.request_digest = memoryHash("orca-jarvis/memory-scoped-write-request/v4\0", base);
  value.request_id = `memreq:scoped:v4:${value.request_digest.slice(7)}`;
  return value;
}
it("validates provider fixture bytes and returns a detached deeply frozen request", () => {
  const decoded = parse(fixture);
  expect(decoded).toEqual(fixture);
  expect(Object.isFrozen(decoded.preparation.binding.identity.projects)).toBe(true);
  expect(Object.isFrozen(decoded.source_request.payload)).toBe(true);
  expect(decoded.preparation.payload.content).toContain("\r\n");
  expect(() => parseMemoryScopedWriteRequestJson(canonicalize(fixture), "provider:other", now)).toThrow("SCOPED_WRITE_REQUEST_INVALID");
});
it.each([
  (r: any) => { r.writer.agent_id = "agent:bad\n"; },
  (r: any) => { r.writer.agent_id = "agent:bad\r"; },
  (r: any) => { r.writer.principal_id = "principal:other"; },
  (r: any) => { r.preparation.binding.identity.projects = ["project:other"]; },
  (r: any) => { r.preparation.binding.identity.candidate_digest = `sha256:${"a".repeat(64)}`; },
  (r: any) => { r.preparation.payload.content = "changed"; },
  (r: any) => { r.preparation.writes_authorized = true; },
  (r: any) => { r.preparation.extra = "unexpected"; },
  (r: any) => { r.expires_at = r.created_at; },
  (r: any) => { r.expires_at = "2099-01-01T00:00:00.000Z"; },
  (r: any) => { r.idempotency_key = `memidem:scoped:v4:${"a".repeat(64)}`; },
])("rejects modified material even with a recomputed outer digest", change => {
  const changed = structuredClone(fixture); change(changed);
  expect(() => parse(reseal(changed))).toThrow("SCOPED_WRITE_REQUEST_INVALID");
});
it("rejects ambiguous, oversized, expired and invalid-clock persisted data", () => {
  for (const raw of ["{}", " ".repeat(32769), JSON.stringify(fixture, null, 2),
    canonicalize(fixture).replace('"schema_version":4', '"schema_version":3,"schema_version":4')]) {
    expect(() => parseMemoryScopedWriteRequestJson(raw, "provider:fixture", now)).toThrow("SCOPED_WRITE_REQUEST_INVALID");
  }
  for (const time of [new Date(fixture.expires_at), new Date(NaN)]) {
    expect(() => parseMemoryScopedWriteRequestJson(canonicalize(fixture), "provider:fixture", time)).toThrow("SCOPED_WRITE_REQUEST_INVALID");
  }
});
